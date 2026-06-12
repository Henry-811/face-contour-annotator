import assert from "node:assert/strict";
import {
  applySoftMoveToContours,
  hitFilledContour,
  hitTestContours,
} from "../src/geometry.js";
import { LABELS, MIN_CLOSED_POINTS, MIN_OPEN_POINTS } from "../src/config.js";
import { normalizeImportedContours } from "../src/exporter.js";

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

testSoftMoveClampsLargeDrag();
testHitTestingKeepsLineAndFillDistinct();
testFilledHitPrefersSmallestContainingContour();
testImportRejectsInvalidPoints();

console.log("logic tests passed");
