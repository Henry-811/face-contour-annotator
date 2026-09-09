import { getInterpolatingCurveSegments, getSegmentDistance as projectPointOnSegment, pointInPolygon } from "./geometry.js?v=workspace-ux-1";

export const CURVE_TOLERANCE = 0.2; // Original-image pixels, independent of zoom.
const MAX_SUBDIVISION_DEPTH = 12;
const MAX_CURVE_SAMPLES = 200000;
const EPSILON = 1e-7;
const copy = (p) => ({ x: p.x, y: p.y });
const lerp = ({ a, b, t }) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function curveSegments(contour) {
  if (!contour.segments) return getInterpolatingCurveSegments(contour.points, contour.closed);
  return contour.segments.map((segment, i) => ({
    start: contour.points[i], end: contour.points[(i + 1) % contour.points.length],
    control1: segment.control1, control2: segment.control2,
  }));
}

export function materializeContour(contour) {
  return { ...contour, points: contour.points.map(copy), segments: curveSegments(contour).map(({ control1, control2 }) => ({ control1: copy(control1), control2: copy(control2) })) };
}

export function splitSegment({ segment, t }) {
  const { start, control1, control2, end } = segment;
  const a = lerp({ a: start, b: control1, t });
  const b = lerp({ a: control1, b: control2, t });
  const c = lerp({ a: control2, b: end, t });
  const d = lerp({ a, b, t });
  const e = lerp({ a: b, b: c, t });
  const point = lerp({ a: d, b: e, t });
  return [ { start, control1: a, control2: d, end: point }, { start: point, control1: e, control2: c, end } ];
}

export function sampleContour(contour) {
  const result = [];
  function flatten({ segment, index, from, to, depth }) {
    // Distance to the finite chord also detects loops and controls past endpoints.
    const error = Math.max(
      projectPointOnSegment(segment.control1, segment.start, segment.end).distance,
      projectPointOnSegment(segment.control2, segment.start, segment.end).distance,
    );
    if (error <= CURVE_TOLERANCE || depth >= MAX_SUBDIVISION_DEPTH) {
      if (result.length >= MAX_CURVE_SAMPLES) throw new Error("This contour is too complex to edit safely. Split it into smaller contours.");
      result.push({ ...segment.end, segmentIndex: index, t: to });
      return;
    }
    const [left, right] = splitSegment({ segment, t: 0.5 });
    const middle = (from + to) / 2;
    flatten({ segment: left, index, from, to: middle, depth: depth + 1 });
    flatten({ segment: right, index, from: middle, to, depth: depth + 1 });
  }
  curveSegments(contour).forEach((segment, index) => {
    if (!result.length) result.push({ ...segment.start, segmentIndex: index, t: 0 });
    flatten({ segment, index, from: 0, to: 1, depth: 0 });
  });
  return result;
}

export function contourPolyline(contour) {
  const points = sampleContour(contour).map(copy);
  if (contour.closed) points.pop();
  return points;
}

function refineCurvePosition({ segment, point, from, to }) {
  const evaluate = (t) => {
    const u = 1 - t;
    return { x: u ** 3 * segment.start.x + 3 * u * u * t * segment.control1.x + 3 * u * t * t * segment.control2.x + t ** 3 * segment.end.x,
      y: u ** 3 * segment.start.y + 3 * u * u * t * segment.control1.y + 3 * u * t * t * segment.control2.y + t ** 3 * segment.end.y };
  };
  let low = from, high = to;
  // Flatness is a spatial bound, not a linear mapping of Bezier parameter t.
  // Refine within the hit sample interval, including exact endpoints.
  for (let i = 0; i < 32; i += 1) {
    const left = low + (high - low) / 3, right = high - (high - low) / 3;
    if (distance(evaluate(left), point) < distance(evaluate(right), point)) high = right;
    else low = left;
  }
  return [from, (low + high) / 2, to].map((t) => ({ t, point: evaluate(t) }))
    .map((hit) => ({ ...hit, distance: distance(hit.point, point) })).sort((a, b) => a.distance - b.distance)[0];
}

export function nearestCurvePoint({ contour, point }) {
  const samples = sampleContour(contour);
  let best = null;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1], b = samples[i];
    const hit = projectPointOnSegment(point, a, b);
    if (!best || hit.distance < best.distance) {
      const fromT = a.segmentIndex === b.segmentIndex ? a.t : 0;
      best = { type: "edge", contour, distance: hit.distance, point: hit.projection,
        segmentIndex: b.segmentIndex, segmentT: fromT + (b.t - fromT) * hit.t, fromT, toT: b.t };
    }
  }
  if (!best) return null;
  const refined = refineCurvePosition({ segment: curveSegments(contour)[best.segmentIndex], point, from: best.fromT, to: best.toT });
  return { type: "edge", contour, segmentIndex: best.segmentIndex, segmentT: refined.t, point: refined.point, distance: refined.distance };
}

export function hitContours({ contours, selectedId, point, tolerance, vertices = true }) {
  // A visible selected handle takes precedence over crossing neighboring curves.
  const selected = contours.find((c) => c.id === selectedId);
  if (vertices && selected) {
    let index = -1, nearest = tolerance;
    selected.points.forEach((p, i) => {
      const d = distance(p, point);
      if (d <= nearest) { nearest = d; index = i; }
    });
    if (index >= 0) return { type: "vertex", contour: selected, pointIndex: index };
  }
  const edges = contours.map((contour) => nearestCurvePoint({ contour, point }))
    .filter((hit) => hit && hit.distance <= tolerance).sort((a, b) => a.distance - b.distance);
  if (edges.length) return edges[0];
  const inside = [...contours].reverse().find((c) => c.closed && pointInPolygon(point, contourPolyline(c)));
  return inside ? { type: "contour", contour: inside } : null;
}

export function isPointInsideImage({ point, imageSize }) {
  return point.x >= 0 && point.y >= 0 && point.x <= imageSize.width && point.y <= imageSize.height;
}

export function insertCurvePoint({ contour, segmentIndex, segmentT, imageSize }) {
  const result = materializeContour(contour);
  if (segmentT <= EPSILON) return { contour: result, pointIndex: segmentIndex };
  if (segmentT >= 1 - EPSILON) return { contour: result, pointIndex: (segmentIndex + 1) % result.points.length };
  const [left, right] = splitSegment({ segment: curveSegments(result)[segmentIndex], t: segmentT });
  if (imageSize && !isPointInsideImage({ point: left.end, imageSize })) {
    throw new Error("This part of the curve is outside the image. Choose a visible point or move the contour inside first.");
  }
  const pointIndex = segmentIndex + 1;
  result.points.splice(pointIndex, 0, copy(left.end));
  result.segments.splice(segmentIndex, 1, ...[left, right].map(({ control1, control2 }) => ({ control1, control2 })));
  return { contour: result, pointIndex };
}

function boundPoint({ point, imageSize }) {
  return { x: Math.max(0, Math.min(imageSize.width, point.x)), y: Math.max(0, Math.min(imageSize.height, point.y)) };
}

export function prepareSoftEdit({ contour, pointIndex, radius, imageSize }) {
  let result = materializeContour(contour);
  if (radius <= 0) return { contour: result, pointIndex, fixedPointIndices: [] };
  const samples = sampleContour(result);
  let total = 0;
  const offsets = samples.map((p, i) => {
    if (i) total += distance(p, samples[i - 1]);
    return total;
  });
  const centerSample = pointIndex === 0 ? 0 : samples.findIndex((p) => p.segmentIndex === pointIndex - 1 && p.t === 1);
  const center = offsets[centerSample];
  if (contour.closed && radius >= total / 2) return { contour: result, pointIndex, fixedPointIndices: [] };
  const boundaryOffsets = [center - radius, center + radius]
    .map((d) => contour.closed ? (d + total) % total : Math.max(0, Math.min(total, d)))
    .filter((d) => Math.abs(d - center) > EPSILON);
  const cuts = boundaryOffsets.map((d) => {
    const index = Math.max(1, offsets.findIndex((offset) => offset >= d));
    const a = samples[index - 1], b = samples[index];
    const t = (d - offsets[index - 1]) / Math.max(EPSILON, offsets[index] - offsets[index - 1]);
    const startT = a.segmentIndex === b.segmentIndex ? a.t : 0;
    const refined = refineCurvePosition({ segment: curveSegments(result)[b.segmentIndex], point: lerp({ a, b, t }), from: startT, to: b.t });
    return { segmentIndex: b.segmentIndex, segmentT: refined.t };
  }).sort((a, b) => (b.segmentIndex + b.segmentT) - (a.segmentIndex + a.segmentT));
  const fixedPointIndices = [];
  for (const [cutIndex, cut] of cuts.entries()) {
    const boundary = splitSegment({ segment: curveSegments(result)[cut.segmentIndex], t: cut.segmentT })[0].end;
    // Historical splines can leave the image even though their anchors are
    // inside. Keep that existing segment instead of inserting an invalid anchor.
    if (imageSize && !isPointInsideImage({ point: boundary, imageSize })) continue;
    const insertion = insertCurvePoint({ contour: result, ...cut, imageSize });
    if (insertion.contour.points.length > result.points.length) {
      if (insertion.pointIndex <= pointIndex) pointIndex += 1;
      fixedPointIndices.forEach((index, i) => { if (index >= insertion.pointIndex) fixedPointIndices[i] += 1; });
      // Descending cuts can share an original segment. The unsplit remainder
      // now has a shorter parameter interval.
      cuts.slice(cutIndex + 1).forEach((next) => {
        if (next.segmentIndex === cut.segmentIndex) next.segmentT /= cut.segmentT;
      });
    }
    fixedPointIndices.push(insertion.pointIndex);
    result = insertion.contour;
  }
  return { contour: result, pointIndex, fixedPointIndices };
}

export function moveCurvePoint({ contour, pointIndex, point, imageSize, radius = 0, fixedPointIndices = [] }) {
  const result = materializeContour(contour);
  const origin = result.points[pointIndex];
  const target = boundPoint({ point, imageSize });
  const delta = { x: target.x - origin.x, y: target.y - origin.y };
  const offsets = [0];
  const segments = curveSegments(result);
  let total = 0;
  // Direct editing does not need arc-length calculation.
  if (radius > 0) segments.forEach((segment) => {
    const samples = sampleContour({ points: [segment.start, segment.end], closed: false, segments: [segment] });
    for (let i = 1; i < samples.length; i += 1) total += distance(samples[i - 1], samples[i]);
    offsets.push(total);
  });
  const weights = result.points.map((_, i) => {
    if (fixedPointIndices.includes(i)) return 0;
    if (!radius) return i === pointIndex ? 1 : 0;
    let d = Math.abs(offsets[i] - offsets[pointIndex]);
    if (result.closed) d = Math.min(d, total - d);
    return i === pointIndex ? 1 : radius > 0 && d < radius ? (1 + Math.cos(Math.PI * d / radius)) / 2 : 0;
  });
  const moved = (p, weight) => weight === 0 ? copy(p) : boundPoint({ point: { x: p.x + delta.x * weight, y: p.y + delta.y * weight }, imageSize });
  result.points = result.points.map((p, i) => moved(p, weights[i]));
  result.segments = result.segments.map((s, i) => ({
    control1: moved(s.control1, weights[i]), control2: moved(s.control2, weights[(i + 1) % weights.length]),
  }));
  return result;
}

function evaluateCubic({ segment, t }) {
  const u = 1 - t;
  const value = (axis) => u ** 3 * segment.start[axis] + 3 * u * u * t * segment.control1[axis]
    + 3 * u * t * t * segment.control2[axis] + t ** 3 * segment.end[axis];
  return { x: value("x"), y: value("y") };
}

function mergeCurveSegments({ left, right }) {
  // A de Casteljau split scales the first/second/third derivatives by t^order.
  // Try each order so stationary points and straight/degenerate curves work too.
  const derivative = ({ segment: s, end, order, axis }) => {
    const [a, b, c, d] = [s.start, s.control1, s.control2, s.end].map((p) => p[axis]);
    if (order === 1) return end ? d - c : b - a;
    if (order === 2) return end ? d - 2 * c + b : c - 2 * b + a;
    return d - 3 * c + 3 * b - a;
  };
  const scale = Math.max(1, ...[left.start, left.control1, left.control2, left.end, right.control1, right.control2, right.end].flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]));
  const tolerance = scale * 1e-9;
  for (const order of [1, 2, 3]) {
    const magnitude = (segment, end) => Math.hypot(...["x", "y"].map((axis) => derivative({ segment, end, order, axis }))) ** (1 / order);
    const before = magnitude(left, true), after = magnitude(right, false);
    const t = before / (before + after);
    if (!Number.isFinite(t) || t <= EPSILON || t >= 1 - EPSILON) continue;
    const control1 = { x: left.start.x + (left.control1.x - left.start.x) / t, y: left.start.y + (left.control1.y - left.start.y) / t };
    const control2 = { x: right.end.x + (right.control2.x - right.end.x) / (1 - t), y: right.end.y + (right.control2.y - right.end.y) / (1 - t) };
    const split = splitSegment({ segment: { start: left.start, control1, control2, end: right.end }, t });
    if ([left, right].every((segment, i) => ["start", "control1", "control2", "end"].every((key) => distance(segment[key], split[i][key]) <= tolerance))) {
      return { segment: { control1, control2 }, exact: true };
    }
  }
  // General two-cubic -> one-cubic conversion is approximate. Fit only this arc;
  // callers must preview it before committing. Endpoints and other arcs stay fixed.
  const samplesPerSegment = 32;
  const sample = (segment) => Array.from({ length: samplesPerSegment + 1 }, (_, i) => evaluateCubic({ segment, t: i / samplesPerSegment }));
  const leftSamples = sample(left), rightSamples = sample(right);
  const length = (points) => points.slice(1).reduce((sum, point, i) => sum + distance(point, points[i]), 0);
  const leftLength = length(leftSamples), rightLength = length(rightSamples);
  const splitT = Math.max(0.01, Math.min(0.99, leftLength / (leftLength + rightLength) || 0.5));
  let aa = 0, ab = 0, bb = 0;
  const rhsA = { x: 0, y: 0 }, rhsB = { x: 0, y: 0 };
  [leftSamples, rightSamples].forEach((points, side) => points.forEach((point, i) => {
    const t = side === 0 ? splitT * i / samplesPerSegment : splitT + (1 - splitT) * i / samplesPerSegment;
    const u = 1 - t, a = 3 * u * u * t, b = 3 * u * t * t;
    aa += a * a; ab += a * b; bb += b * b;
    for (const axis of ["x", "y"]) {
      const value = point[axis] - u ** 3 * left.start[axis] - t ** 3 * right.end[axis];
      rhsA[axis] += a * value; rhsB[axis] += b * value;
    }
  }));
  const determinant = aa * bb - ab * ab;
  const control1 = {}, control2 = {};
  for (const axis of ["x", "y"]) {
    control1[axis] = (rhsA[axis] * bb - rhsB[axis] * ab) / determinant;
    control2[axis] = (rhsB[axis] * aa - rhsA[axis] * ab) / determinant;
  }
  return { segment: { control1, control2 }, exact: false };
}

export function planPointDeletion({ contour, pointIndex }) {
  if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= contour.points.length) return null;
  if (contour.points.length <= (contour.closed ? 3 : 2)) return null;
  const result = materializeContour(contour);
  const n = result.points.length;
  let exact = false;
  if (!result.closed && pointIndex === 0) result.segments.shift();
  else if (!result.closed && pointIndex === n - 1) result.segments.pop();
  else {
    const previous = (pointIndex - 1 + n) % n;
    const segments = curveSegments(result);
    const joined = mergeCurveSegments({ left: segments[previous], right: segments[pointIndex] });
    result.segments[previous] = joined.segment;
    exact = joined.exact;
    result.segments.splice(pointIndex, 1);
  }
  result.points.splice(pointIndex, 1);
  return { contour: result, exact };
}

export function deleteCurvePoint(options) {
  return planPointDeletion(options)?.contour || null;
}

export function contourBounds(contour) {
  const points = [...contour.points, ...curveSegments(contour).flatMap((s) => [s.control1, s.control2])];
  return points.reduce((b, p) => ({ minX: Math.min(b.minX, p.x), maxX: Math.max(b.maxX, p.x), minY: Math.min(b.minY, p.y), maxY: Math.max(b.maxY, p.y) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
}

export function transformContour({ contour, pivot, scaleX = 1, scaleY = 1, angle = 0, dx = 0, dy = 0, imageSize }) {
  const result = materializeContour(contour);
  const transform = (p) => {
    const x = (p.x - pivot.x) * scaleX, y = (p.y - pivot.y) * scaleY;
    return { x: pivot.x + x * Math.cos(angle) - y * Math.sin(angle) + dx,
      y: pivot.y + x * Math.sin(angle) + y * Math.cos(angle) + dy };
  };
  result.points = result.points.map(transform);
  result.segments = result.segments.map((s) => ({ control1: transform(s.control1), control2: transform(s.control2) }));
  const b = contourBounds(result);
  if (b.maxX - b.minX > imageSize.width || b.maxY - b.minY > imageSize.height) return materializeContour(contour);
  const offset = { x: Math.max(0, -b.minX) + Math.min(0, imageSize.width - b.maxX), y: Math.max(0, -b.minY) + Math.min(0, imageSize.height - b.maxY) };
  const shift = (p) => ({ x: p.x + offset.x, y: p.y + offset.y });
  result.points = result.points.map(shift);
  result.segments = result.segments.map((s) => ({ control1: shift(s.control1), control2: shift(s.control2) }));
  return result;
}

export function transformHandles({ contour, scale, imageSize }) {
  const b = contourBounds(contour);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  let rotateY = b.minY - 28 / scale;
  if (imageSize && rotateY < 8 / scale) rotateY = Math.min(imageSize.height - 8 / scale, b.maxY + 28 / scale);
  return { bounds: b, center: { x: cx, y: cy }, rotationBase: { x: cx, y: rotateY > cy ? b.maxY : b.minY }, handles: [
    ["nw", b.minX, b.minY, b.maxX, b.maxY], ["n", cx, b.minY, cx, b.maxY],
    ["ne", b.maxX, b.minY, b.minX, b.maxY], ["e", b.maxX, cy, b.minX, cy],
    ["se", b.maxX, b.maxY, b.minX, b.minY], ["s", cx, b.maxY, cx, b.minY],
    ["sw", b.minX, b.maxY, b.maxX, b.minY], ["w", b.minX, cy, b.maxX, cy],
    ["rotate", cx, rotateY, cx, cy],
  ].map(([name, x, y, px, py]) => ({ name, point: { x, y }, pivot: { x: px, y: py } })) };
}

export function hitTransformHandle({ contour, scale, imageSize, point }) {
  return transformHandles({ contour, scale, imageSize }).handles
    .map((handle) => ({ handle, distance: distance(handle.point, point) }))
    .filter((hit) => hit.distance <= 10 / scale)
    .sort((a, b) => a.distance - b.distance)[0]?.handle || null;
}

function sliceSegments({ segments, from, to }) {
  const result = [];
  for (let i = Math.floor(from); i < Math.ceil(to); i += 1) {
    const startT = Math.max(0, from - i), endT = Math.min(1, to - i);
    if (endT - startT <= EPSILON) continue;
    let part = segments[i % segments.length];
    if (endT < 1) [part] = splitSegment({ segment: part, t: endT });
    if (startT > 0) [, part] = splitSegment({ segment: part, t: startT / endT });
    result.push(part);
  }
  return result;
}

export function redrawContour({ contour, start, end, points, alternate = false }) {
  const segments = curveSegments(contour), n = segments.length;
  let from = start.segmentIndex + start.segmentT, to = end.segmentIndex + end.segmentT;
  if (Math.abs(from - to) < EPSILON || (contour.closed && Math.abs(Math.abs(from - to) - n) < EPSILON)) throw new Error("Choose two different positions on the contour.");
  let path = points.map(copy);
  if ((!contour.closed && from > to) || (contour.closed && alternate)) {
    [from, to] = [to, from]; path.reverse();
  }
  if (contour.closed && to < from) to += n;
  const replaced = sliceSegments({ segments, from, to });
  const anchors = [replaced[0].start, ...path, replaced.at(-1).end];
  const replacement = curveSegments({ points: anchors, closed: false });
  let combined;
  if (contour.closed) combined = [...replacement, ...sliceSegments({ segments, from: to, to: from + n })];
  else combined = [...sliceSegments({ segments, from: 0, to: from }), ...replacement, ...sliceSegments({ segments, from: to, to: n })];
  if (contour.closed && combined.length < 3) combined.splice(0, 1, ...splitSegment({ segment: combined[0], t: 0.5 }));
  const result = { ...contour, points: combined.map((s) => copy(s.start)), segments: combined.map(({ control1, control2 }) => ({ control1: copy(control1), control2: copy(control2) })) };
  if (!contour.closed) result.points.push(copy(combined.at(-1).end));
  return { contour: result, replaced: { points: [...replaced.map((s) => s.start), replaced.at(-1).end], segments: replaced, closed: false } };
}

export function validateCurve(contour) {
  const expected = contour.points.length - (contour.closed ? 0 : 1);
  if (!Array.isArray(contour.segments) || contour.segments.length !== expected || contour.segments.some((s) =>
    ![s?.control1, s?.control2].every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)))) {
    throw new Error("Invalid cubic curve controls.");
  }
  return contour;
}
