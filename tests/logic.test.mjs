import assert from "node:assert/strict";
import {
  applySoftMoveToContours,
  getInterpolatingCurveSegments,
  hitFilledContour,
  hitTestContours,
} from "../src/geometry.js";
import { LABELS, MIN_CLOSED_POINTS, MIN_OPEN_POINTS } from "../src/config.js";
import {
  buildAnnotationExport,
  buildProjectExport,
  normalizeImportedContours,
  validateContoursForTaskSchema,
} from "../src/exporter.js";
import {
  createAnnotationProject,
  createProjectImage,
  getFilePath,
  getAdjacentImageId,
  getProgress,
  hydrateProjectImages,
  toProjectImageRecord,
  toProjectMetadata,
} from "../src/project.js";
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

function assertPointClose(actual, expected, epsilon = 0.000001) {
  assert.equal(Math.abs(actual.x - expected.x) <= epsilon, true);
  assert.equal(Math.abs(actual.y - expected.y) <= epsilon, true);
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

function testHitTestingOpenEndpointWithoutShowingPoints() {
  const contour = {
    id: "nose",
    label: "nose",
    closed: false,
    points: [
      { x: 100, y: 100 },
      { x: 110, y: 150 },
      { x: 140, y: 170 },
    ],
  };

  const hit = hitTestContours({
    contours: [contour],
    point: { x: 101, y: 100 },
    showPoints: false,
    scale: 1,
    hitRadius: 10,
    lineHitRadius: 4,
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
      { x: 100, y: 100 },
      { x: 120, y: 100 },
      { x: 140, y: 100 },
      { x: 160, y: 100 },
    ],
  };

  const result = applySoftMoveToContours({
    contours: [contour],
    contourId: "brow",
    interaction: {
      pointIndex: 0,
      startPoint: { x: 100, y: 100 },
    },
    point: { x: 120, y: 100 },
    softRadius: 16,
    imageSize: { width: 512, height: 512 },
    softDragConfig: {
      minDistance: 6,
      maxDistance: 64,
      radiusRatio: 1,
      endpointRadiusMultiplier: 2.25,
    },
  });

  const points = result.contours[0].points;
  assert.equal(points[0].x > 100, true);
  assert.equal(points[0].x <= 120, true);
  assert.equal(points[1].x > 120, true);
  assert.equal(points[1].x < 136, true);
  assert.equal(points[3].x, 160);
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
  const mouthSeamSchema = exportData.taskSchema.labels.find(
    (label) => label.id === "mouth_seam",
  );
  const eyeSchema = exportData.taskSchema.labels.find((label) => label.id === "left_eye");

  assert.equal(exportData.taskSchema.coordinateSystem, "image_pixels");
  assert.equal(noseSchema.defaultShapeType, "linestrip");
  assert.deepEqual(noseSchema.allowedShapeTypes, ["linestrip"]);
  assert.equal(mouthSeamSchema.defaultShapeType, "linestrip");
  assert.deepEqual(mouthSeamSchema.allowedShapeTypes, ["linestrip"]);
  assert.deepEqual(eyeSchema.allowedShapeTypes, ["polygon"]);
  assert.equal(exportData.contours[0].shape_type, "linestrip");
}

function testProjectExportIncludesAllImagesAndProgress() {
  const project = createAnnotationProject({
    images: [
      createProjectImage({
        id: "img_001",
        name: "face001.jpg",
        path: "batch_a/face001.jpg",
        width: 512,
        height: 512,
        dataUrl: "data:image/jpeg;base64,abc",
        status: "done",
        contours: [
          {
            id: "left_eye",
            label: "left_eye",
            closed: true,
            points: [
              { x: 10, y: 10 },
              { x: 20, y: 10 },
              { x: 15, y: 18 },
            ],
          },
        ],
      }),
      createProjectImage({
        id: "img_002",
        name: "face002.jpg",
        path: "batch_a/face002.jpg",
        width: 512,
        height: 512,
        dataUrl: "data:image/jpeg;base64,def",
        status: "skipped",
        contours: [],
      }),
    ],
    taskSchema: {},
  });

  const exportData = buildProjectExport({ project, labels: LABELS });

  assert.equal(exportData.version, "face-contour-project-v1");
  assert.equal(exportData.images.length, 2);
  assert.equal(exportData.images[0].path, "batch_a/face001.jpg");
  assert.equal("dataUrl" in exportData.images[0], false);
  assert.equal(exportData.progress.total, 2);
  assert.equal(exportData.progress.done, 1);
  assert.equal(exportData.progress.skipped, 1);
  assert.equal(exportData.images[0].contours[0].shape_type, "polygon");
}

function testProjectProgressCountsStatuses() {
  const progress = getProgress([
    { status: "done" },
    { status: "skipped" },
    { status: "needs_review" },
    { status: "in_progress" },
    { status: "unlabeled" },
  ]);

  assert.equal(progress.total, 5);
  assert.equal(progress.done, 1);
  assert.equal(progress.skipped, 1);
  assert.equal(progress.needs_review, 1);
  assert.equal(progress.in_progress, 1);
  assert.equal(progress.unlabeled, 1);
}

function testProjectMetadataOmitsImagePayload() {
  const project = createAnnotationProject({
    images: [
      createProjectImage({
        id: "img_001",
        name: "face001.jpg",
        width: 512,
        height: 512,
        dataUrl: "data:image/jpeg;base64,abc",
        contours: [
          {
            id: "left_eye",
            label: "left_eye",
            closed: true,
            points: [
              { x: 10, y: 10 },
              { x: 20, y: 10 },
              { x: 15, y: 18 },
            ],
          },
        ],
      }),
    ],
    taskSchema: {},
  });

  const metadata = toProjectMetadata(project);

  assert.equal("dataUrl" in metadata.images[0], false);
  assert.equal("contours" in metadata.images[0], false);
  assert.equal(metadata.images[0].status, "unlabeled");
}

function testProjectImageRecordOmitsDataUrl() {
  const image = createProjectImage({
    id: "img_001",
    name: "face001.jpg",
    width: 512,
    height: 512,
    dataUrl: "data:image/jpeg;base64,abc",
    contours: [
      {
        id: "nose",
        label: "nose",
        closed: false,
        points: [
          { x: 10, y: 10 },
          { x: 20, y: 30 },
        ],
      },
    ],
  });

  const record = toProjectImageRecord(image);

  assert.equal("dataUrl" in record, false);
  assert.equal(record.contours.length, 1);
  assert.equal(record.contours[0].label, "nose");
}

function testHydrateProjectImagesMergesImageRecords() {
  const project = createAnnotationProject({
    images: [
      createProjectImage({
        id: "img_001",
        name: "face001.jpg",
        width: 512,
        height: 512,
        dataUrl: "data:image/jpeg;base64,abc",
      }),
    ],
    taskSchema: {},
  });
  const metadata = toProjectMetadata(project);
  const record = {
    ...metadata.images[0],
    status: "done",
    contours: [
      {
        id: "mouth",
        label: "mouth",
        closed: true,
        points: [
          { x: 10, y: 10 },
          { x: 20, y: 10 },
          { x: 15, y: 18 },
        ],
      },
    ],
  };

  const hydrated = hydrateProjectImages(metadata, [record]);

  assert.equal(hydrated.images[0].status, "done");
  assert.equal(hydrated.images[0].contours[0].label, "mouth");
  assert.equal(hydrated.images[0].dataUrl, undefined);
}

function testProjectAdjacentImageNavigation() {
  const project = createAnnotationProject({
    images: [
      createProjectImage({
        id: "img_001",
        name: "a.jpg",
        width: 10,
        height: 10,
        dataUrl: "data:image/jpeg;base64,a",
      }),
      createProjectImage({
        id: "img_002",
        name: "b.jpg",
        width: 10,
        height: 10,
        dataUrl: "data:image/jpeg;base64,b",
      }),
    ],
    taskSchema: {},
  });

  assert.equal(getAdjacentImageId(project, -1), null);
  assert.equal(getAdjacentImageId(project, 1), "img_002");
  project.currentImageId = "img_002";
  assert.equal(getAdjacentImageId(project, -1), "img_001");
  assert.equal(getAdjacentImageId(project, 1), null);
}

function testFolderImportPreservesRelativePath() {
  assert.equal(
    getFilePath({
      name: "face001.jpg",
      webkitRelativePath: "batch_a/face001.jpg",
    }),
    "batch_a/face001.jpg",
  );
  assert.equal(getFilePath({ name: "face002.jpg" }), "face002.jpg");
}

function testDoneValidationRejectsInvalidContours() {
  const errors = validateContoursForTaskSchema({
    contours: [
      {
        id: "bad_eye",
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
    minOpenPoints: MIN_OPEN_POINTS,
    minClosedPoints: MIN_CLOSED_POINTS,
  });

  assert.match(errors[0], /does not allow linestrip/);
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
  assert.equal(contourByLabel.get("mouth_seam").closed, false);
  assert.equal(contourByLabel.get("left_eyebrow").closed, false);
  assert.equal(contourByLabel.get("left_eye").closed, true);
  assert.equal(contourByLabel.get("left_eye").points.length, 16);
  assert.equal(contourByLabel.get("mouth").points.length, 14);
  assert.equal(contourByLabel.get("mouth_seam").points.length, 7);
  assert.equal(contourByLabel.get("left_ear").points.length, 18);
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

function testFeatureTemplateRejectsTinyImages() {
  assert.throws(
    () =>
      buildDefaultFeatureContours({
        imageSize: { width: 1, height: 1 },
        existingContours: [],
        labels: LABELS,
        createId: () => "template",
      }),
    /at least/,
  );
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

function testLabelHitFindsContourFromLabelRect() {
  const hit = hitContourLabel(
    [
      {
        contour: { id: "left_eye" },
        labelRect: { x: 40, y: 60, width: 80, height: 20 },
      },
    ],
    { x: 42, y: 61 },
    4,
  );

  assert.equal(hit.type, "label");
  assert.equal(hit.contour.id, "left_eye");
}

function testInterpolatingCurveSegmentsPassThroughContourPoints() {
  const points = [
    { x: 10, y: 10 },
    { x: 30, y: 5 },
    { x: 50, y: 20 },
    { x: 35, y: 40 },
  ];

  const openSegments = getInterpolatingCurveSegments(points, false);
  assert.equal(openSegments.length, points.length - 1);
  assertPointClose(openSegments[0].start, points[0]);
  openSegments.forEach((segment, index) => {
    assertPointClose(segment.end, points[index + 1]);
  });

  const closedSegments = getInterpolatingCurveSegments(points, true);
  assert.equal(closedSegments.length, points.length);
  closedSegments.forEach((segment, index) => {
    assertPointClose(segment.start, points[index]);
    assertPointClose(segment.end, points[(index + 1) % points.length]);
  });
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

testSoftMoveClampsLargeDrag();
testHitTestingKeepsLineAndFillDistinct();
testFilledHitPrefersSmallestContainingContour();
testHitTestingOpenEndpointWithoutShowingPoints();
testOpenEndpointSoftMoveSpreadsToNeighborPoints();
testImportRejectsInvalidPoints();
testExportIncludesTaskSchema();
testProjectExportIncludesAllImagesAndProgress();
testProjectProgressCountsStatuses();
testProjectMetadataOmitsImagePayload();
testProjectImageRecordOmitsDataUrl();
testHydrateProjectImagesMergesImageRecords();
testProjectAdjacentImageNavigation();
testFolderImportPreservesRelativePath();
testDoneValidationRejectsInvalidContours();
testFeatureTemplateMatchesTaskSchema();
testFeatureTemplateSkipsExistingLabels();
testFeatureTemplateRejectsTinyImages();
testImportRejectsDisallowedLabelShape();
testImportRejectsUnknownLabel();
testLabelHitFindsContourFromLabelRect();
testInterpolatingCurveSegmentsPassThroughContourPoints();
testLabelPlacementUsesRealContourPoint();
testLabelPlacementAvoidsExistingLabels();
testFitCanvasScaleUsesStageBounds();
testApplyCanvasScaleAllowsZoomBeyondWorkspace();

console.log("logic tests passed");
