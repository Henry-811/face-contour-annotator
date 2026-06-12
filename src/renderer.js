import { getContourSegments, interpolatePoint } from "./geometry.js";

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

function getLabelPlacement({ bounds, labelWidth, labelHeight, canvasWidth, canvasHeight }) {
  const gap = 5;
  const x = clamp(bounds.left, 0, Math.max(0, canvasWidth - labelWidth));
  const topY = bounds.top - labelHeight - gap;
  if (topY >= 0) {
    return { x, y: topY };
  }
  const bottomY = bounds.bottom + gap;
  if (bottomY + labelHeight <= canvasHeight) {
    return { x, y: bottomY };
  }
  return {
    x,
    y: clamp(topY, 0, Math.max(0, canvasHeight - labelHeight)),
  };
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

function drawContour(ctx, contour, isSelected, options) {
  const { canvasHeight, canvasWidth, labels, maxControlHandles, pointRadius, scale, showPoints } =
    options;
  const label = getLabel(labels, contour.label);
  const displayPoints = contour.points.map((point) => toDisplayPoint(point, scale));
  if (!displayPoints.length) {
    return;
  }
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (isSelected) {
    drawSmoothPath(ctx, displayPoints, Boolean(contour.closed));
    ctx.strokeStyle = "rgba(255, 255, 255, 0.84)";
    ctx.lineWidth = 8;
    ctx.stroke();
  }
  drawSmoothPath(ctx, displayPoints, Boolean(contour.closed));
  ctx.fillStyle = `${label.color}24`;
  ctx.strokeStyle = label.color;
  ctx.lineWidth = isSelected ? 4 : 2;
  if (contour.closed) {
    ctx.fill();
  }
  ctx.stroke();

  const bounds = getDisplayBounds(displayPoints);
  ctx.font = "12px system-ui, sans-serif";
  const labelWidth = Math.max(48, ctx.measureText(label.name).width + 12);
  const labelHeight = 18;
  const labelPlacement = getLabelPlacement({
    bounds,
    labelWidth,
    labelHeight,
    canvasWidth,
    canvasHeight,
  });
  ctx.fillStyle = label.color;
  ctx.fillRect(labelPlacement.x, labelPlacement.y, labelWidth, labelHeight);
  ctx.fillStyle = "#fff";
  ctx.fillText(label.name, labelPlacement.x + 6, labelPlacement.y + 14);

  if (isSelected && showPoints) {
    const handleStride = Math.max(1, Math.ceil(displayPoints.length / maxControlHandles));
    displayPoints.forEach((point, pointIndex) => {
      const isEndpoint = !contour.closed && (pointIndex === 0 || pointIndex === displayPoints.length - 1);
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
  }
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

export function fitCanvasToImage({ canvas, stageShell, image }) {
  if (!image) {
    return null;
  }
  const maxWidth = Math.max(240, stageShell.clientWidth - 36);
  const maxHeight = Math.max(240, stageShell.clientHeight - 36);
  const scale = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight, 1.75);
  const nextScale = Math.max(0.08, scale);
  canvas.style.width = `${Math.round(image.naturalWidth * nextScale)}px`;
  canvas.style.height = `${Math.round(image.naturalHeight * nextScale)}px`;
  return nextScale;
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
  const options = {
    canvasHeight: cssHeight,
    canvasWidth: cssWidth,
    labels,
    maxControlHandles,
    pointRadius,
    scale,
    showPoints,
  };
  contours.forEach((contour) => drawContour(ctx, contour, contour.id === selectedId, options));
  drawDraft(ctx, draftPoints, hoverPoint, { activeLabel, labels, pointRadius, scale });
}
