import assert from "node:assert/strict";
import {
  applySoftMoveToContours,
  hitFilledContour,
  hitTestContours,
} from "../src/geometry.js";
import { LABELS, MIN_CLOSED_POINTS, MIN_OPEN_POINTS } from "../src/config.js";
import { normalizeImportedContours } from "../src/exporter.js";
import { getContourLabelPlacements } from "../src/renderer.js";

function getBounds(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

function makeLabelEntry({ id, points, labelWidth = 70, labelHeight = 18 }) {
  return {
    closed: true,
    contour: { id },
    displayPoints: points,
    isSelected: false,
    label: { id, name: id, color: "#087e6b" },
    labelHeight,
    labelWidth,
    bounds: getBounds(points),
  };
}

function rectsOverlap(a, b) {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function testSoftMoveClampsLargeDrag() {
  const contour = {
    id: "eye",
    label: "left_eye",
    closed: true,
    points: [
      { x: 100, y: 100 },
      { x: 120, y: 100 },
      { x: 120, y: 120 },
      { x: 100, y: 120 },
    ],
  };
  const result = applySoftMoveToContours({
    contours: [contour],
    contourId: "eye",
    interaction: {
      segmentIndex: 0,
      segmentT: 0,
      startPoint: { x: 0, y: 0 },
    },
    point: { x: 100, y: 0 },
    softRadius: 80,
    imageSize: { width: 512, height: 512 },
    softDragConfig: {
      minDistance: 6,
      maxDistance: 10,
      radiusRatio: 1,
    },
  });

  assert.equal(result.wasClamped, true);
  assert.equal(result.contours[0].points[0].x, 110);
  assert.equal(result.contours[0].points[0].y, 100);
}

function testHitTestingKeepsLineAndFillDistinct() {
  const contour = {
    id: "eye",
    label: "left_eye",
    closed: true,
    points: [
      { x: 100, y: 100 },
      { x: 140, y: 100 },
      { x: 140, y: 130 },
      { x: 100, y: 130 },
    ],
  };

  const edgeHit = hitTestContours({
    contours: [contour],
    point: { x: 120, y: 101 },
    showPoints: false,
    scale: 1,
    hitRadius: 10,
    lineHitRadius: 18,
  });
  const fillHit = hitFilledContour([contour], { x: 120, y: 115 });

  assert.equal(edgeHit.type, "edge");
  assert.equal(fillHit.type, "contour");
}

function testFilledHitPrefersSmallestContainingContour() {
  const face = {
    id: "face",
    label: "face_outline",
    closed: true,
    points: [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
      { x: 0, y: 200 },
    ],
  };
  const eye = {
    id: "eye",
    label: "left_eye",
    closed: true,
    points: [
      { x: 80, y: 80 },
      { x: 120, y: 80 },
      { x: 120, y: 110 },
      { x: 80, y: 110 },
    ],
  };

  const hit = hitFilledContour([eye, face], { x: 100, y: 95 });

  assert.equal(hit.contour.id, "eye");
}

function testImportRejectsInvalidPoints() {
  assert.throws(
    () =>
      normalizeImportedContours({
        contours: [
          {
            label: "left_eye",
            closed: true,
            points: [
              { x: 1, y: 1 },
              { x: "bad", y: 2 },
              { x: 3, y: 3 },
            ],
          },
        ],
        labels: LABELS,
        imageSize: { width: 512, height: 512 },
        createId: () => "contour_test",
        minOpenPoints: MIN_OPEN_POINTS,
        minClosedPoints: MIN_CLOSED_POINTS,
      }),
    /numeric/,
  );
}

function testLabelPlacementUsesRealContourPoint() {
  const face = makeLabelEntry({
    id: "face_outline",
    labelWidth: 72,
    points: [
      { x: 120, y: 50 },
      { x: 180, y: 90 },
      { x: 80, y: 230 },
      { x: 10, y: 150 },
    ],
  });

  const [placement] = getContourLabelPlacements([face], {
    canvasWidth: 260,
    canvasHeight: 260,
  });

  assert.ok(placement.labelRect.x > 70);
  assert.ok(placement.labelRect.x < 120);
}

function testLabelPlacementAvoidsExistingLabels() {
  const eye = makeLabelEntry({
    id: "left_eye",
    points: [
      { x: 100, y: 100 },
      { x: 130, y: 103 },
      { x: 115, y: 116 },
    ],
  });
  const eyebrow = makeLabelEntry({
    id: "left_eyebrow",
    labelWidth: 92,
    points: [
      { x: 98, y: 92 },
      { x: 132, y: 93 },
      { x: 115, y: 99 },
    ],
  });

  const placements = getContourLabelPlacements([eye, eyebrow], {
    canvasWidth: 260,
    canvasHeight: 260,
  });

  assert.equal(rectsOverlap(placements[0].labelRect, placements[1].labelRect), false);
}

testSoftMoveClampsLargeDrag();
testHitTestingKeepsLineAndFillDistinct();
testFilledHitPrefersSmallestContainingContour();
testImportRejectsInvalidPoints();
testLabelPlacementUsesRealContourPoint();
testLabelPlacementAvoidsExistingLabels();

console.log("logic tests passed");
