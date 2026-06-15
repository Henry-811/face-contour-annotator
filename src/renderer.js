import { getContourSegments, interpolatePoint } from "./geometry.js";

const LABEL_GAP = 5;
const LABEL_COLLISION_GAP = 3;
const LABEL_HEIGHT = 18;
const LABEL_MIN_WIDTH = 48;
const LABEL_TEXT_PADDING_X = 12;
const LABEL_STACK_LIMIT = 3;
const LABEL_LINE_COLLISION_WEIGHT = 10000;
const LABEL_LABEL_COLLISION_WEIGHT = 100000;
const GEOMETRY_EPSILON = 0.000001;
const CANVAS_PADDING = 36;
const MAX_FIT_SCALE = 1.75;
const MIN_CANVAS_SCALE = 0.08;

function getLabel(labels, labelId) {
  return labels.find((label) => label.id === labelId) || labels[0];
}

function toDisplayPoint(point, scale) {
  return {
    x: point.x * scale,
    y: point.y * scale,
  };
}

function getDisplayBounds(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getRectCenter(rect) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

function getClampedRect(rect, canvasWidth, canvasHeight) {
  return {
    ...rect,
    x: clamp(rect.x, 0, Math.max(0, canvasWidth - rect.width)),
    y: clamp(rect.y, 0, Math.max(0, canvasHeight - rect.height)),
  };
}

function rectsOverlap(a, b, gap = 0) {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}

function pointInRect(point, rect, gap = 0) {
  return (
    point.x >= rect.x - gap &&
    point.x <= rect.x + rect.width + gap &&
    point.y >= rect.y - gap &&
    point.y <= rect.y + rect.height + gap
  );
}

function getOrientation(a, b, c) {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}

function isPointOnSegment(point, start, end) {
  return (
    point.x >= Math.min(start.x, end.x) - GEOMETRY_EPSILON &&
    point.x <= Math.max(start.x, end.x) + GEOMETRY_EPSILON &&
    point.y >= Math.min(start.y, end.y) - GEOMETRY_EPSILON &&
    point.y <= Math.max(start.y, end.y) + GEOMETRY_EPSILON
  );
}

function segmentsIntersect(a, b, c, d) {
  const o1 = getOrientation(a, b, c);
  const o2 = getOrientation(a, b, d);
  const o3 = getOrientation(c, d, a);
  const o4 = getOrientation(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) {
    return true;
  }
  return (
    (Math.abs(o1) <= GEOMETRY_EPSILON && isPointOnSegment(c, a, b)) ||
    (Math.abs(o2) <= GEOMETRY_EPSILON && isPointOnSegment(d, a, b)) ||
    (Math.abs(o3) <= GEOMETRY_EPSILON && isPointOnSegment(a, c, d)) ||
    (Math.abs(o4) <= GEOMETRY_EPSILON && isPointOnSegment(b, c, d))
  );
}

function segmentIntersectsRect(start, end, rect, gap = 0) {
  const expanded = {
    x: rect.x - gap,
    y: rect.y - gap,
    width: rect.width + gap * 2,
    height: rect.height + gap * 2,
  };
  if (pointInRect(start, expanded) || pointInRect(end, expanded)) {
    return true;
  }
  const topLeft = { x: expanded.x, y: expanded.y };
  const topRight = { x: expanded.x + expanded.width, y: expanded.y };
  const bottomRight = {
    x: expanded.x + expanded.width,
    y: expanded.y + expanded.height,
  };
  const bottomLeft = { x: expanded.x, y: expanded.y + expanded.height };
  return (
    segmentsIntersect(start, end, topLeft, topRight) ||
    segmentsIntersect(start, end, topRight, bottomRight) ||
    segmentsIntersect(start, end, bottomRight, bottomLeft) ||
    segmentsIntersect(start, end, bottomLeft, topLeft)
  );
}

function countContourCollisions(rect, displayContours) {
  let collisions = 0;
  displayContours.forEach(({ closed, displayPoints }) => {
    displayPoints.forEach((point) => {
      if (pointInRect(point, rect, LABEL_COLLISION_GAP)) {
        collisions += 1;
      }
    });
    getContourSegments({ closed, points: displayPoints }).forEach((segment) => {
      if (
        segmentIntersectsRect(
          displayPoints[segment.index],
          displayPoints[segment.nextIndex],
          rect,
          LABEL_COLLISION_GAP,
        )
      ) {
        collisions += 2;
      }
    });
  });
  return collisions;
}

function countLabelCollisions(rect, occupiedRects) {
  return occupiedRects.filter((occupied) => rectsOverlap(rect, occupied, LABEL_COLLISION_GAP))
    .length;
}

function buildLabelCandidates(entry, canvasWidth, canvasHeight) {
  const { bounds, displayPoints, labelHeight, labelWidth } = entry;
  const candidates = [];
  displayPoints.forEach((point) => {
    const anchorPenalty = point.y - bounds.top;
    for (let stack = 0; stack <= LABEL_STACK_LIMIT; stack += 1) {
      const stackOffset = stack * (labelHeight + LABEL_COLLISION_GAP);
      const placements = [
        {
          preference: 0,
          rect: {
            x: point.x - labelWidth / 2,
            y: point.y - labelHeight - LABEL_GAP - stackOffset,
            width: labelWidth,
            height: labelHeight,
          },
        },
        {
          preference: 22,
          rect: {
            x: point.x - labelWidth / 2,
            y: point.y + LABEL_GAP + stackOffset,
            width: labelWidth,
            height: labelHeight,
          },
        },
        {
          preference: 34,
          rect: {
            x: point.x + LABEL_GAP + stackOffset,
            y: point.y - labelHeight / 2,
            width: labelWidth,
            height: labelHeight,
          },
        },
        {
          preference: 34,
          rect: {
            x: point.x - labelWidth - LABEL_GAP - stackOffset,
            y: point.y - labelHeight / 2,
            width: labelWidth,
            height: labelHeight,
          },
        },
      ];
      placements.forEach((placement) => {
        const rect = getClampedRect(placement.rect, canvasWidth, canvasHeight);
        const center = getRectCenter(rect);
        candidates.push({
          anchor: point,
          rect,
          baseScore:
            placement.preference +
            stack * 18 +
            anchorPenalty * 0.35 +
            Math.hypot(center.x - point.x, center.y - point.y) * 0.15,
        });
      });
    }
  });
  return candidates;
}

function getBestLabelPlacement(entry, displayContours, occupiedRects, canvasWidth, canvasHeight) {
  let bestCandidate = null;
  buildLabelCandidates(entry, canvasWidth, canvasHeight).forEach((candidate) => {
    const lineCollisions = countContourCollisions(candidate.rect, displayContours);
    const labelCollisions = countLabelCollisions(candidate.rect, occupiedRects);
    const score =
      candidate.baseScore +
      lineCollisions * LABEL_LINE_COLLISION_WEIGHT +
      labelCollisions * LABEL_LABEL_COLLISION_WEIGHT;
    if (!bestCandidate || score < bestCandidate.score) {
      bestCandidate = { ...candidate, score };
    }
  });
  if (bestCandidate) {
    return bestCandidate.rect;
  }
  return {
    x: 0,
    y: 0,
    width: entry.labelWidth,
    height: entry.labelHeight,
  };
}

export function getContourLabelPlacements(entries, { canvasWidth, canvasHeight }) {
  const occupiedRects = [];
  return entries.map((entry) => {
    const rect = getBestLabelPlacement(
      entry,
      entries,
      occupiedRects,
      canvasWidth,
      canvasHeight,
    );
    occupiedRects.push(rect);
    return { ...entry, labelRect: rect };
  });
}

function syncCanvasBackingStore(canvas, dpr) {
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
  const targetHeight = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  return { cssWidth, cssHeight };
}

function drawSmoothPath(ctx, displayPoints, closed) {
  if (!displayPoints.length) {
    return;
  }
  ctx.beginPath();
  if (displayPoints.length < 3) {
    ctx.moveTo(displayPoints[0].x, displayPoints[0].y);
    displayPoints.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
    return;
  }
  if (closed) {
    const last = displayPoints[displayPoints.length - 1];
    const first = displayPoints[0];
    ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
    displayPoints.forEach((point, index) => {
      const next = displayPoints[(index + 1) % displayPoints.length];
      const control = interpolatePoint(point, next, 0.5);
      ctx.quadraticCurveTo(point.x, point.y, control.x, control.y);
    });
    ctx.closePath();
    return;
  }
  ctx.moveTo(displayPoints[0].x, displayPoints[0].y);
  for (let index = 1; index < displayPoints.length - 1; index += 1) {
    const point = displayPoints[index];
    const next = displayPoints[index + 1];
    const control = interpolatePoint(point, next, 0.5);
    ctx.quadraticCurveTo(point.x, point.y, control.x, control.y);
  }
  const last = displayPoints[displayPoints.length - 1];
  ctx.lineTo(last.x, last.y);
}

function drawContourPath(ctx, { closed, displayPoints, isSelected, label }) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (isSelected) {
    drawSmoothPath(ctx, displayPoints, closed);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.84)";
    ctx.lineWidth = 8;
    ctx.stroke();
  }
  drawSmoothPath(ctx, displayPoints, closed);
  ctx.fillStyle = `${label.color}24`;
  ctx.strokeStyle = label.color;
  ctx.lineWidth = isSelected ? 4 : 2;
  if (closed) {
    ctx.fill();
  }
  ctx.stroke();
  ctx.restore();
}

function drawContourLabel(ctx, { label, labelRect }) {
  ctx.save();
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillStyle = label.color;
  ctx.fillRect(labelRect.x, labelRect.y, labelRect.width, labelRect.height);
  ctx.fillStyle = "#fff";
  ctx.fillText(label.name, labelRect.x + 6, labelRect.y + 14);
  ctx.restore();
}

function drawContourHandles(ctx, { closed, displayPoints, label, maxControlHandles, pointRadius }) {
  const handleStride = Math.max(1, Math.ceil(displayPoints.length / maxControlHandles));
  ctx.save();
  displayPoints.forEach((point, pointIndex) => {
    const isEndpoint = !closed && (pointIndex === 0 || pointIndex === displayPoints.length - 1);
    if (pointIndex % handleStride !== 0 && !isEndpoint) {
      return;
    }
    ctx.beginPath();
    ctx.arc(point.x, point.y, isEndpoint ? pointRadius + 1 : pointRadius, 0, Math.PI * 2);
    ctx.fillStyle = isEndpoint ? "#ffffff" : label.color;
    ctx.strokeStyle = label.color;
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}

function drawDraft(ctx, draftPoints, hoverPoint, options) {
  const { activeLabel, labels, pointRadius, scale } = options;
  if (!draftPoints.length) {
    return;
  }
  const label = getLabel(labels, activeLabel);
  const displayPoints = draftPoints.map((point) => toDisplayPoint(point, scale));
  ctx.save();
  ctx.strokeStyle = label.color;
  ctx.fillStyle = label.color;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  displayPoints.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
  if (hoverPoint) {
    const displayHover = toDisplayPoint(hoverPoint, scale);
    ctx.lineTo(displayHover.x, displayHover.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  displayPoints.forEach((point, index) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, index === 0 ? pointRadius + 2 : pointRadius, 0, Math.PI * 2);
    ctx.fillStyle = index === 0 ? "#ffffff" : label.color;
    ctx.strokeStyle = label.color;
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}

export function getFitCanvasScale({ stageShell, image }) {
  if (!image) {
    return null;
  }
  const maxWidth = Math.max(240, stageShell.clientWidth - CANVAS_PADDING);
  const maxHeight = Math.max(240, stageShell.clientHeight - CANVAS_PADDING);
  const scale = Math.min(
    maxWidth / image.naturalWidth,
    maxHeight / image.naturalHeight,
    MAX_FIT_SCALE,
  );
  return Math.max(MIN_CANVAS_SCALE, scale);
}

export function applyCanvasScale({ canvas, image, scale }) {
  if (!image) {
    return null;
  }
  const nextScale = Math.max(MIN_CANVAS_SCALE, scale);
  canvas.style.width = `${Math.round(image.naturalWidth * nextScale)}px`;
  canvas.style.height = `${Math.round(image.naturalHeight * nextScale)}px`;
  return nextScale;
}

export function fitCanvasToImage({ canvas, stageShell, image }) {
  const scale = getFitCanvasScale({ stageShell, image });
  if (scale === null) {
    return null;
  }
  return applyCanvasScale({ canvas, image, scale });
}

export function drawAnnotationCanvas({
  canvas,
  ctx,
  image,
  scale,
  contours,
  selectedId,
  draftPoints,
  hoverPoint,
  activeLabel,
  labels,
  showPoints,
  pointRadius,
  maxControlHandles,
}) {
  const dpr = window.devicePixelRatio || 1;
  const { cssWidth, cssHeight } = syncCanvasBackingStore(canvas, dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  if (!image) {
    return;
  }
  ctx.drawImage(image, 0, 0, cssWidth, cssHeight);
  ctx.font = "12px system-ui, sans-serif";
  const displayContours = contours
    .map((contour) => {
      const displayPoints = contour.points.map((point) => toDisplayPoint(point, scale));
      if (!displayPoints.length) {
        return null;
      }
      const label = getLabel(labels, contour.label);
      return {
        closed: Boolean(contour.closed),
        contour,
        displayPoints,
        isSelected: contour.id === selectedId,
        label,
        labelHeight: LABEL_HEIGHT,
        labelWidth: Math.max(LABEL_MIN_WIDTH, ctx.measureText(label.name).width + LABEL_TEXT_PADDING_X),
        bounds: getDisplayBounds(displayPoints),
      };
    })
    .filter(Boolean);
  displayContours.forEach((entry) => drawContourPath(ctx, entry));
  const labelPlacements = getContourLabelPlacements(displayContours, {
    canvasHeight: cssHeight,
    canvasWidth: cssWidth,
  });
  labelPlacements.forEach((entry) => drawContourLabel(ctx, entry));
  labelPlacements.forEach((entry) => {
    if (entry.isSelected && showPoints) {
      drawContourHandles(ctx, {
        ...entry,
        maxControlHandles,
        pointRadius,
      });
    }
  });
  drawDraft(ctx, draftPoints, hoverPoint, { activeLabel, labels, pointRadius, scale });
}
