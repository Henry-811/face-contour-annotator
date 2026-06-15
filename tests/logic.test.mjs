import assert from "node:assert/strict";
import {
  applySoftMoveToContours,
  getInterpolatingCurveSegments,
  hitFilledContour,
  hitTestContours,
} from "../src/geometry.js";
import { LABELS, MIN_CLOSED_POINTS, MIN_OPEN_POINTS } from "../src/config.js";
import { buildAnnotationExport, normalizeImportedContours } from "../src/exporter.js";
import {
  applyCanvasScale,
  getContourLabelPlacements,
  getFitCanvasScale,
  hitContourLabel,
} from "../src/renderer.js";
import { buildDefaultFeatureContours } from "../src/templates.js";

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

function assertPointClose(actual, expected) {
  assert.equal(Math.abs(actual.x - expected.x) < 0.000001, true);
  assert.equal(Math.abs(actual.y - expected.y) < 0.000001, true);
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

function testHitTestingOpenEndpointWithoutShowingPoints() {
  const contour = {
    id: "brow",
    label: "left_eyebrow",
    closed: false,
    points: [
      { x: 10, y: 20 },
      { x: 50, y: 20 },
      { x: 90, y: 25 },
    ],
  };

  const hit = hitTestContours({
    contours: [contour],
    point: { x: 10, y: 20 },
    showPoints: false,
    scale: 1,
    hitRadius: 10,
    lineHitRadius: 18,
  });

  assert.equal(hit.type, "vertex");
  assert.equal(hit.pointIndex, 0);
}

function testOpenEndpointSoftMoveSpreadsToNeighborPoints() {
  const contour = {
    id: "brow",
    label: "left_eyebrow",
    closed: false,
    points: [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 40, y: 0 },
      { x: 60, y: 0 },
    ],
  };

  const result = applySoftMoveToContours({
    contours: [contour],
    contourId: "brow",
    interaction: {
      pointIndex: 0,
      startPoint: { x: 0, y: 0 },
    },
    point: { x: 0, y: 30 },
    softRadius: 20,
    imageSize: { width: 100, height: 100 },
    softDragConfig: {
      minDistance: 6,
      maxDistance: 30,
      radiusRatio: 2,
      endpointRadiusMultiplier: 3,
    },
  });

  assert.equal(result.contours[0].points[0].y, 30);
  assert.equal(result.contours[0].points[1].y > 15, true);
  assert.equal(result.contours[0].points[2].y > 0, true);
  assert.equal(result.contours[0].points[3].y, 0);
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

function testExportIncludesTaskSchema() {
  const exportData = buildAnnotationExport({
    image: { naturalWidth: 512, naturalHeight: 512 },
    fileName: "face.jpg",
    labels: LABELS,
    contours: [
      {
        id: "nose_line",
        label: "nose",
        closed: false,
        points: [
          { x: 10, y: 20 },
          { x: 12, y: 28 },
        ],
      },
    ],
  });

  const noseSchema = exportData.taskSchema.labels.find((label) => label.id === "nose");
  const eyeSchema = exportData.taskSchema.labels.find((label) => label.id === "left_eye");
  const mouthSeamSchema = exportData.taskSchema.labels.find(
    (label) => label.id === "mouth_seam",
  );

  assert.equal(exportData.taskSchema.coordinateSystem, "image_pixels");
  assert.equal(noseSchema.defaultShapeType, "linestrip");
  assert.deepEqual(noseSchema.allowedShapeTypes, ["linestrip"]);
  assert.deepEqual(eyeSchema.allowedShapeTypes, ["polygon"]);
  assert.equal(mouthSeamSchema.defaultShapeType, "linestrip");
  assert.deepEqual(mouthSeamSchema.allowedShapeTypes, ["linestrip"]);
  assert.equal(exportData.contours[0].shape_type, "linestrip");
}

function testFeatureTemplateMatchesTaskSchema() {
  let nextId = 0;
  const contours = buildDefaultFeatureContours({
    imageSize: { width: 512, height: 512 },
    existingContours: [],
    labels: LABELS,
    createId: () => `template_${++nextId}`,
  });

  const normalized = normalizeImportedContours({
    contours,
    labels: LABELS,
    imageSize: { width: 512, height: 512 },
    createId: () => "unused",
    minOpenPoints: MIN_OPEN_POINTS,
    minClosedPoints: MIN_CLOSED_POINTS,
  });
  const contourByLabel = new Map(normalized.map((contour) => [contour.label, contour]));

  assert.equal(contours.length, 9);
  assert.equal(contourByLabel.get("nose").closed, false);
  assert.equal(contourByLabel.get("left_eyebrow").closed, false);
  assert.equal(contourByLabel.get("left_eye").closed, true);
  assert.equal(contourByLabel.get("mouth").points.length >= MIN_CLOSED_POINTS, true);
  assert.equal(contourByLabel.get("mouth_seam").closed, false);
  assert.equal(contourByLabel.get("mouth_seam").points.length >= MIN_OPEN_POINTS, true);
}

function testFeatureTemplateMouthUsesLipOutline() {
  const contours = buildDefaultFeatureContours({
    imageSize: { width: 512, height: 512 },
    existingContours: [],
    labels: LABELS,
    createId: () => "template",
  });
  const mouth = contours.find((contour) => contour.label === "mouth");
  const yValues = mouth.points.map((point) => point.y);
  const leftCorner = mouth.points[0];
  const upperCenter = mouth.points[4];
  const lowerCenter = mouth.points[11];

  assert.equal(mouth.closed, true);
  assert.equal(mouth.points.length, 14);
  assert.equal(Math.min(...yValues) < leftCorner.y, true);
  assert.equal(Math.max(...yValues), lowerCenter.y);
  assert.equal(upperCenter.y < leftCorner.y, true);
  assert.equal(lowerCenter.y > leftCorner.y, true);
}

function testFeatureTemplateMouthSeamUsesOpenLine() {
  const contours = buildDefaultFeatureContours({
    imageSize: { width: 512, height: 512 },
    existingContours: [],
    labels: LABELS,
    createId: () => "template",
  });
  const mouth = contours.find((contour) => contour.label === "mouth");
  const mouthSeam = contours.find((contour) => contour.label === "mouth_seam");
  const mouthBounds = getBounds(mouth.points);
  const seamBounds = getBounds(mouthSeam.points);

  assert.equal(mouthSeam.closed, false);
  assert.equal(mouthSeam.points.length, 7);
  assert.equal(seamBounds.left > mouthBounds.left, true);
  assert.equal(seamBounds.right < mouthBounds.right, true);
  assert.equal(seamBounds.top > mouthBounds.top, true);
  assert.equal(seamBounds.bottom < mouthBounds.bottom, true);
}

function testFeatureTemplateEyeUsesDetailedAlmondOutline() {
  const contours = buildDefaultFeatureContours({
    imageSize: { width: 512, height: 512 },
    existingContours: [],
    labels: LABELS,
    createId: () => "template",
  });
  const eye = contours.find((contour) => contour.label === "left_eye");
  const eyeBounds = getBounds(eye.points);
  const leftCorner = eye.points[0];
  const rightCorner = eye.points[8];
  const upperCenter = eye.points[4];
  const lowerCenter = eye.points[12];

  assert.equal(eye.closed, true);
  assert.equal(eye.points.length, 16);
  assert.equal(leftCorner.y, rightCorner.y);
  assert.equal(upperCenter.y < leftCorner.y, true);
  assert.equal(lowerCenter.y > leftCorner.y, true);
  assert.equal(eyeBounds.right - eyeBounds.left > eyeBounds.bottom - eyeBounds.top, true);
}

function testFeatureTemplateEarUsesDetailedTallOutline() {
  const contours = buildDefaultFeatureContours({
    imageSize: { width: 512, height: 512 },
    existingContours: [],
    labels: LABELS,
    createId: () => "template",
  });
  const leftEar = contours.find((contour) => contour.label === "left_ear");
  const rightEar = contours.find((contour) => contour.label === "right_ear");
  const leftBounds = getBounds(leftEar.points);
  const rightBounds = getBounds(rightEar.points);

  assert.equal(leftEar.closed, true);
  assert.equal(rightEar.closed, true);
  assert.equal(leftEar.points.length, 18);
  assert.equal(rightEar.points.length, 18);
  assert.equal(leftBounds.bottom - leftBounds.top > (leftBounds.right - leftBounds.left) * 3, true);
  assert.equal(rightBounds.bottom - rightBounds.top > (rightBounds.right - rightBounds.left) * 3, true);
}

function testFeatureTemplateSkipsExistingLabels() {
  const contours = buildDefaultFeatureContours({
    imageSize: { width: 512, height: 512 },
    existingContours: [
      {
        id: "manual_left_eye",
        label: "left_eye",
        closed: true,
        points: [
          { x: 1, y: 1 },
          { x: 2, y: 1 },
          { x: 2, y: 2 },
        ],
      },
    ],
    labels: LABELS,
    createId: () => "template",
  });

  assert.equal(contours.some((contour) => contour.label === "left_eye"), false);
  assert.equal(contours.length, 8);
}

function testImportRejectsDisallowedLabelShape() {
  assert.throws(
    () =>
      normalizeImportedContours({
        contours: [
          {
            label: "left_eye",
            closed: false,
            points: [
              { x: 1, y: 1 },
              { x: 2, y: 2 },
            ],
          },
        ],
        labels: LABELS,
        imageSize: { width: 512, height: 512 },
        createId: () => "contour_test",
        minOpenPoints: MIN_OPEN_POINTS,
        minClosedPoints: MIN_CLOSED_POINTS,
      }),
    /does not allow linestrip/,
  );
}

function testImportRejectsUnknownLabel() {
  assert.throws(
    () =>
      normalizeImportedContours({
        contours: [
          {
            label: "unknown_label",
            closed: false,
            points: [
              { x: 1, y: 1 },
              { x: 2, y: 2 },
            ],
          },
        ],
        labels: LABELS,
        imageSize: { width: 512, height: 512 },
        createId: () => "contour_test",
        minOpenPoints: MIN_OPEN_POINTS,
        minClosedPoints: MIN_CLOSED_POINTS,
      }),
    /Unknown contour label/,
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

function testLabelHitFindsContourFromLabelRect() {
  const eye = makeLabelEntry({
    id: "left_eye",
    points: [
      { x: 100, y: 100 },
      { x: 130, y: 103 },
      { x: 115, y: 116 },
    ],
  });
  const [placement] = getContourLabelPlacements([eye], {
    canvasWidth: 260,
    canvasHeight: 260,
  });

  const hit = hitContourLabel(
    [placement],
    {
      x: placement.labelRect.x + placement.labelRect.width / 2,
      y: placement.labelRect.y + placement.labelRect.height / 2,
    },
    4,
  );

  assert.equal(hit.type, "label");
  assert.equal(hit.contour.id, "left_eye");
}

function testFitCanvasScaleUsesStageBounds() {
  const scale = getFitCanvasScale({
    stageShell: { clientWidth: 900, clientHeight: 700 },
    image: { naturalWidth: 512, naturalHeight: 512 },
  });

  assert.equal(scale, (700 - 36) / 512);
}

function testApplyCanvasScaleAllowsZoomBeyondWorkspace() {
  const canvas = { style: {} };
  const scale = applyCanvasScale({
    canvas,
    image: { naturalWidth: 512, naturalHeight: 512 },
    scale: 2,
  });

  assert.equal(scale, 2);
  assert.equal(canvas.style.width, "1024px");
  assert.equal(canvas.style.height, "1024px");
}

function testInterpolatingCurveSegmentsPassThroughContourPoints() {
  const points = [
    { x: 10, y: 20 },
    { x: 25, y: 5 },
    { x: 50, y: 28 },
    { x: 80, y: 18 },
  ];

  const openSegments = getInterpolatingCurveSegments(points, false);
  assert.equal(openSegments.length, points.length - 1);
  openSegments.forEach((segment, index) => {
    assertPointClose(segment.start, points[index]);
    assertPointClose(segment.end, points[index + 1]);
  });

  const closedSegments = getInterpolatingCurveSegments(points, true);
  assert.equal(closedSegments.length, points.length);
  closedSegments.forEach((segment, index) => {
    assertPointClose(segment.start, points[index]);
    assertPointClose(segment.end, points[(index + 1) % points.length]);
  });
}

testSoftMoveClampsLargeDrag();
testHitTestingKeepsLineAndFillDistinct();
testHitTestingOpenEndpointWithoutShowingPoints();
testOpenEndpointSoftMoveSpreadsToNeighborPoints();
testFilledHitPrefersSmallestContainingContour();
testImportRejectsInvalidPoints();
testExportIncludesTaskSchema();
testFeatureTemplateMatchesTaskSchema();
testFeatureTemplateMouthUsesLipOutline();
testFeatureTemplateMouthSeamUsesOpenLine();
testFeatureTemplateEyeUsesDetailedAlmondOutline();
testFeatureTemplateEarUsesDetailedTallOutline();
testFeatureTemplateSkipsExistingLabels();
testImportRejectsDisallowedLabelShape();
testImportRejectsUnknownLabel();
testLabelPlacementUsesRealContourPoint();
testLabelPlacementAvoidsExistingLabels();
testLabelHitFindsContourFromLabelRect();
testFitCanvasScaleUsesStageBounds();
testApplyCanvasScaleAllowsZoomBeyondWorkspace();
testInterpolatingCurveSegmentsPassThroughContourPoints();

console.log("logic tests passed");
