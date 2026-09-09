export function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function cloneContours(contours) {
  return structuredClone(contours);
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function clampPointToImage(point, imageSize) {
  if (!imageSize) {
    return { ...point };
  }
  return {
    x: Math.round(clamp(finiteNumber(point.x), 0, imageSize.width)),
    y: Math.round(clamp(finiteNumber(point.y), 0, imageSize.height)),
  };
}

export function normalizePointToImage(point, imageSize) {
  return clampPointToImage(
    {
      x: finiteNumber(point.x),
      y: finiteNumber(point.y),
    },
    imageSize,
  );
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(start, end, t) {
  return start + (end - start) * t;
}

export function interpolatePoint(start, end, t) {
  return {
    x: lerp(start.x, end.x, t),
    y: lerp(start.y, end.y, t),
  };
}

const CATMULL_ROM_BEZIER_FACTOR = 1 / 6;

function getWrappedPoint(points, index) {
  const wrappedIndex = (index + points.length) % points.length;
  return points[wrappedIndex];
}

function getOpenPathPoint(points, index) {
  return points[clamp(index, 0, points.length - 1)];
}

export function getInterpolatingCurveSegments(points, closed) {
  if (points.length < 2) {
    return [];
  }
  const segmentCount = closed ? points.length : points.length - 1;
  return Array.from({ length: segmentCount }, (_, index) => {
    const p0 = closed ? getWrappedPoint(points, index - 1) : getOpenPathPoint(points, index - 1);
    const p1 = closed ? getWrappedPoint(points, index) : getOpenPathPoint(points, index);
    const p2 = closed ? getWrappedPoint(points, index + 1) : getOpenPathPoint(points, index + 1);
    const p3 = closed ? getWrappedPoint(points, index + 2) : getOpenPathPoint(points, index + 2);
    return {
      start: { ...p1 },
      control1: {
        x: p1.x + (p2.x - p0.x) * CATMULL_ROM_BEZIER_FACTOR,
        y: p1.y + (p2.y - p0.y) * CATMULL_ROM_BEZIER_FACTOR,
      },
      control2: {
        x: p2.x - (p3.x - p1.x) * CATMULL_ROM_BEZIER_FACTOR,
        y: p2.y - (p3.y - p1.y) * CATMULL_ROM_BEZIER_FACTOR,
      },
      end: { ...p2 },
    };
  });
}

export function getSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return { distance: distance(point, start), t: 0, projection: { ...start } };
  }
  const rawT = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const t = clamp(rawT, 0, 1);
  const projection = interpolatePoint(start, end, t);
  return { distance: distance(point, projection), t, projection };
}

export function getContourSegments(contour) {
  const segments = [];
  const lastIndex = contour.closed ? contour.points.length : contour.points.length - 1;
  for (let index = 0; index < lastIndex; index += 1) {
    const nextIndex = (index + 1) % contour.points.length;
    if (contour.points[index] && contour.points[nextIndex]) {
      segments.push({ index, nextIndex });
    }
  }
  return segments;
}

export function densifyPoints(points, closed, { spacing, imageSize }) {
  if (points.length < 2) {
    return points.map((point) => ({ ...point }));
  }
  const result = [];
  const segmentCount = closed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const segmentLength = distance(start, end);
    const steps = Math.max(1, Math.ceil(segmentLength / spacing));
    result.push({ ...start });
    for (let step = 1; step < steps; step += 1) {
      result.push(interpolatePoint(start, end, step / steps));
    }
  }
  if (!closed) {
    result.push({ ...points[points.length - 1] });
  }
  return result.map((point) => normalizePointToImage(point, imageSize));
}

export function getPathOffsets(contour) {
  const offsets = [0];
  for (let index = 1; index < contour.points.length; index += 1) {
    offsets[index] = offsets[index - 1] + distance(contour.points[index - 1], contour.points[index]);
  }
  const perimeter = contour.closed
    ? offsets[offsets.length - 1] +
      distance(contour.points[contour.points.length - 1], contour.points[0])
    : offsets[offsets.length - 1];
  return { offsets, perimeter };
}

export function getAnchorOffset(contour, interaction) {
  const { offsets } = getPathOffsets(contour);
  if (interaction.segmentIndex !== undefined) {
    const start = contour.points[interaction.segmentIndex];
    const end = contour.points[(interaction.segmentIndex + 1) % contour.points.length];
    return offsets[interaction.segmentIndex] + distance(start, end) * interaction.segmentT;
  }
  return offsets[interaction.pointIndex] || 0;
}

export function getContourPathDistance(contour, pointIndex, anchorOffset) {
  const { offsets, perimeter } = getPathOffsets(contour);
  const directDistance = Math.abs((offsets[pointIndex] || 0) - anchorOffset);
  if (!contour.closed || perimeter === 0) {
    return directDistance;
  }
  return Math.min(directDistance, perimeter - directDistance);
}

export function getSoftWeight(pathDistance, radius) {
  if (pathDistance > radius) {
    return 0;
  }
  return 0.5 + 0.5 * Math.cos((Math.PI * pathDistance) / radius);
}

export function getSoftDragLimit(softRadius, { minDistance, maxDistance, radiusRatio }) {
  return clamp(softRadius * radiusRatio, minDistance, maxDistance);
}

function isOpenEndpointIndex(contour, pointIndex) {
  return !contour.closed && (pointIndex === 0 || pointIndex === contour.points.length - 1);
}

function isOpenEndpointSegment(contour, interaction) {
  if (contour.closed || interaction.segmentIndex === undefined) {
    return false;
  }
  const lastSegmentIndex = contour.points.length - 2;
  return (
    (interaction.segmentIndex === 0 && interaction.segmentT <= 0.2) ||
    (interaction.segmentIndex === lastSegmentIndex && interaction.segmentT >= 0.8)
  );
}

export function isOpenEndpointInteraction(contour, interaction) {
  return (
    isOpenEndpointIndex(contour, interaction.pointIndex) ||
    isOpenEndpointSegment(contour, interaction)
  );
}

export function clampVector(dx, dy, maxLength) {
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length === 0 || length <= maxLength) {
    return { dx, dy, clamped: false };
  }
  const scale = maxLength / length;
  return {
    dx: dx * scale,
    dy: dy * scale,
    clamped: true,
  };
}

export function getContourBounds(contour) {
  const xs = contour.points.map((point) => point.x);
  const ys = contour.points.map((point) => point.y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

export function pointInPolygon(point, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const pi = points[i];
    const pj = points[j];
    const intersects =
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

export function polygonArea(points) {
  if (points.length < 3) {
    return 0;
  }
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}

export function hitFilledContour(contours, point) {
  let bestHit = null;
  let bestArea = Infinity;
  for (let i = contours.length - 1; i >= 0; i -= 1) {
    const contour = contours[i];
    if (contour.closed && pointInPolygon(point, contour.points)) {
      const area = polygonArea(contour.points);
      if (area < bestArea) {
        bestArea = area;
        bestHit = { type: "contour", contour };
      }
    }
  }
  return bestHit;
}

export function hitTestContours({ contours, point, showPoints, scale, hitRadius, lineHitRadius }) {
  for (let i = contours.length - 1; i >= 0; i -= 1) {
    const contour = contours[i];
    for (let pointIndex = 0; pointIndex < contour.points.length; pointIndex += 1) {
      const canHitPoint = showPoints || isOpenEndpointIndex(contour, pointIndex);
      if (canHitPoint && distance(point, contour.points[pointIndex]) <= hitRadius / scale) {
        return { type: "vertex", contour, pointIndex };
      }
    }
    for (const segment of getContourSegments(contour)) {
      const hit = getSegmentDistance(
        point,
        contour.points[segment.index],
        contour.points[segment.nextIndex],
      );
      if (hit.distance <= lineHitRadius / scale) {
        return {
          type: "edge",
          contour,
          segmentIndex: segment.index,
          segmentT: hit.t,
        };
      }
    }
  }
  return hitFilledContour(contours, point);
}

export function clampMoveDelta(contours, dx, dy, imageSize) {
  let minDx = -Infinity;
  let maxDx = Infinity;
  let minDy = -Infinity;
  let maxDy = Infinity;
  contours.forEach((contour) => {
    const bounds = getContourBounds(contour);
    minDx = Math.max(minDx, -bounds.left);
    maxDx = Math.min(maxDx, imageSize.width - bounds.right);
    minDy = Math.max(minDy, -bounds.top);
    maxDy = Math.min(maxDy, imageSize.height - bounds.bottom);
  });
  return {
    dx: clamp(dx, minDx, maxDx),
    dy: clamp(dy, minDy, maxDy),
  };
}

export function moveContourPoints(points, dx, dy, imageSize) {
  return points.map((point) => clampPointToImage({ x: point.x + dx, y: point.y + dy }, imageSize));
}

export function applySoftMoveToContours({
  contours,
  contourId,
  interaction,
  point,
  softRadius,
  imageSize,
  softDragConfig,
}) {
  const limitedDelta = clampVector(
    point.x - interaction.startPoint.x,
    point.y - interaction.startPoint.y,
    getSoftDragLimit(softRadius, softDragConfig),
  );
  const nextContours = contours.map((contour) => {
    if (contour.id !== contourId) {
      return {
        ...contour,
        points: contour.points.map((item) => ({ ...item })),
      };
    }
    const endpointMultiplier = finiteNumber(softDragConfig.endpointRadiusMultiplier, 1);
    const radius = Math.max(
      1,
      softRadius * (isOpenEndpointInteraction(contour, interaction) ? endpointMultiplier : 1),
    );
    const anchorOffset = getAnchorOffset(contour, interaction);
    return {
      ...contour,
      points: contour.points.map((item, pointIndex) => {
        const pathDistance = getContourPathDistance(contour, pointIndex, anchorOffset);
        const weight = getSoftWeight(pathDistance, radius);
        if (weight === 0) {
          return { ...item };
        }
        return clampPointToImage(
          {
            x: item.x + limitedDelta.dx * weight,
            y: item.y + limitedDelta.dy * weight,
          },
          imageSize,
        );
      }),
    };
  });
  return { contours: nextContours, wasClamped: limitedDelta.clamped };
}
