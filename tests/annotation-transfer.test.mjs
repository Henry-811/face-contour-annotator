import assert from "node:assert/strict";
import { LABELS } from "../src/config.js";
import {
  ANNOTATION_FILE_KIND,
  ANNOTATION_FILE_SCHEMA_VERSION,
  ANNOTATION_TRANSFER_ERROR_CODES,
  AnnotationTransferError,
  applyAnnotationImport,
  assertAnnotationImportHasMatches,
  buildAnnotationFile,
  normalizeAnnotationRelativePath,
  parseAnnotationFile,
  planAnnotationImport,
  stripSharedRootDirectory,
} from "../src/annotation-transfer.js";
import { createAnnotationProject, createProjectImage } from "../src/project.js";

const FIXED_NOW = "2026-08-03T00:00:00.000Z";

function makeContour(id = "eye_1", x = 10) {
  return {
    id,
    label: "left_eye",
    closed: true,
    points: [
      { x, y: 10 },
      { x: 20, y: 10 },
      { x: 15, y: 20 },
    ],
  };
}

function makeImage({ id, path, width = 512, height = 512, status = "unlabeled", contours = [] }) {
  return createProjectImage({
    id,
    name: path.split("/").at(-1),
    path,
    width,
    height,
    dataUrl: `data:image/jpeg;base64,${id}`,
    fileSize: 999,
    contentHash: "a".repeat(64),
    contours,
    status,
  });
}

function makeImageSet() {
  const imageSet = createAnnotationProject({
    id: "internal_only",
    name: "Faces 01",
    images: [
      makeImage({
        id: "img_1",
        path: "front/001.jpg",
        status: "done",
        contours: [makeContour()],
      }),
      makeImage({
        id: "img_2",
        path: "side/002.jpg",
        width: 640,
        height: 480,
        status: "in_progress",
        contours: [makeContour("eye_2", 30)],
      }),
      makeImage({ id: "img_3", path: "003.jpg", status: "skipped" }),
    ],
    taskSchema: {},
  });
  imageSet.currentImageId = "img_2";
  imageSet.images.forEach((image) => {
    image.updatedAt = FIXED_NOW;
  });
  return imageSet;
}

function assertTransferError(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof AnnotationTransferError, true);
    assert.equal(error.code, code);
    return true;
  });
}

function testBuildsOnePortableAnnotationFile() {
  const payload = buildAnnotationFile({
    imageSet: makeImageSet(),
    labels: LABELS,
    exportedAt: FIXED_NOW,
  });
  assert.equal(payload.kind, ANNOTATION_FILE_KIND);
  assert.equal(payload.schemaVersion, ANNOTATION_FILE_SCHEMA_VERSION);
  assert.equal(payload.images.length, 3);
  assert.equal(payload.imageSet.currentImagePath, "side/002.jpg");
  assert.deepEqual(payload.images.map((image) => image.status), ["done", "in_progress", "skipped"]);
  const serialized = JSON.stringify(payload);
  [
    "internal_only",
    "data:image",
    "contentHash",
    "fileSize",
    "projectId",
    "localWriteToken",
    '\"id\":\"img_',
  ].forEach(
    (forbidden) => assert.equal(serialized.includes(forbidden), false, forbidden),
  );
}

function testRoundTripsApplicationFormat() {
  const payload = buildAnnotationFile({
    imageSet: makeImageSet(),
    labels: LABELS,
    exportedAt: FIXED_NOW,
  });
  const parsed = parseAnnotationFile({ data: payload, labels: LABELS, createId: () => "generated" });
  assert.equal(parsed.legacy, false);
  assert.equal(parsed.name, "Faces 01");
  assert.equal(parsed.currentImagePath, "side/002.jpg");
  assert.equal(parsed.images[0].contours[0].id, "eye_1");
}

function testReadsReleasedAggregateAsOneWayMigration() {
  const parsed = parseAnnotationFile({
    data: {
      version: "face-contour-project-v1",
      currentImageId: "legacy_2",
      images: [
        {
          id: "legacy_1",
          path: "old-root/front/001.jpg",
          width: 512,
          height: 512,
          status: "done",
          contours: [makeContour()],
        },
        {
          id: "legacy_2",
          path: "old-root/side/002.jpg",
          width: 640,
          height: 480,
          status: "in_progress",
          contours: [makeContour("eye_2")],
        },
      ],
    },
    labels: LABELS,
    createId: () => "generated",
  });
  assert.equal(parsed.legacy, true);
  assert.deepEqual(parsed.images.map((image) => image.relativePath), ["front/001.jpg", "side/002.jpg"]);
  assert.equal(parsed.currentImagePath, "side/002.jpg");
}

function testNormalizesAndRejectsUnsafePaths() {
  assert.equal(normalizeAnnotationRelativePath("./faces\\001.jpg"), "faces/001.jpg");
  assert.equal(normalizeAnnotationRelativePath("faces/e\u0301.jpg"), "faces/é.jpg");
  assert.deepEqual(stripSharedRootDirectory(["batch/a.jpg", "batch/sub/b.jpg"]), [
    "a.jpg",
    "sub/b.jpg",
  ]);
  assert.deepEqual(stripSharedRootDirectory(["a.jpg", "sub/b.jpg"]), ["a.jpg", "sub/b.jpg"]);
  ["../secret.jpg", "/root.jpg", "C:/root.jpg", "a/../b.jpg"].forEach((path) =>
    assertTransferError(
      () => normalizeAnnotationRelativePath(path),
      ANNOTATION_TRANSFER_ERROR_CODES.INVALID_PATH,
    ),
  );
}

function testRejectsDuplicatePathsAndInvalidDoneRecord() {
  const image = {
    relativePath: "a/one.jpg",
    width: 100,
    height: 100,
    status: "unlabeled",
    contours: [],
  };
  const base = {
    kind: ANNOTATION_FILE_KIND,
    schemaVersion: 1,
    imageSet: { name: "Test" },
    images: [image],
  };
  assertTransferError(
    () => parseAnnotationFile({
      data: { ...base, images: [image, { ...image, relativePath: "A/ONE.JPG" }] },
      labels: LABELS,
      createId: () => "generated",
    }),
    ANNOTATION_TRANSFER_ERROR_CODES.DUPLICATE_PATH,
  );
  assertTransferError(
    () => parseAnnotationFile({
      data: { ...base, images: [{ ...image, status: "done" }] },
      labels: LABELS,
      createId: () => "generated",
    }),
    ANNOTATION_TRANSFER_ERROR_CODES.INVALID_IMAGE,
  );
}

function testRejectsDuplicateContourIds() {
  const image = {
    relativePath: "one.jpg",
    width: 100,
    height: 100,
    status: "in_progress",
    contours: [makeContour("duplicate"), makeContour("duplicate", 30)],
  };
  assertTransferError(
    () =>
      parseAnnotationFile({
        data: {
          kind: ANNOTATION_FILE_KIND,
          schemaVersion: 1,
          imageSet: { name: "Test" },
          images: [image],
        },
        labels: LABELS,
        createId: () => "generated",
      }),
    ANNOTATION_TRANSFER_ERROR_CODES.INVALID_IMAGE,
  );
  const contourWithoutId = makeContour();
  delete contourWithoutId.id;
  assertTransferError(
    () =>
      parseAnnotationFile({
        data: {
          kind: ANNOTATION_FILE_KIND,
          schemaVersion: 1,
          imageSet: { name: "Test" },
          images: [{ ...image, contours: [contourWithoutId] }],
        },
        labels: LABELS,
        createId: () => "generated",
      }),
    ANNOTATION_TRANSFER_ERROR_CODES.INVALID_IMAGE,
  );
}

function testPlansAndAppliesPartialImport() {
  const imageSet = makeImageSet();
  const annotations = {
    currentImagePath: "front/001.jpg",
    images: [
      {
        relativePath: "front/001.jpg",
        width: 512,
        height: 512,
        status: "done",
        contours: [makeContour("replacement", 40)],
      },
      {
        relativePath: "side/002.jpg",
        width: 100,
        height: 100,
        status: "done",
        contours: [makeContour("wrong-size")],
      },
      {
        relativePath: "missing.jpg",
        width: 512,
        height: 512,
        status: "done",
        contours: [makeContour("missing")],
      },
    ],
  };
  const plan = planAnnotationImport({ annotations, targetImages: imageSet.images });
  assert.deepEqual(plan.summary, {
    annotationImages: 3,
    targetImages: 3,
    matched: 1,
    unmatched: 1,
    conflicts: 1,
    overwriteCount: 1,
  });
  const updated = applyAnnotationImport({ imageSet, annotations, plan, importedAt: FIXED_NOW });
  assert.equal(updated.currentImageId, "img_1");
  assert.equal(updated.images[0].contours[0].id, "replacement");
  assert.equal(updated.images[1].contours[0].id, "eye_2");
  assert.notEqual(updated.images, imageSet.images);
}

function testRepeatedApplyIsBusinessIdempotent() {
  const imageSet = makeImageSet();
  const payload = buildAnnotationFile({ imageSet, labels: LABELS, exportedAt: FIXED_NOW });
  const annotations = parseAnnotationFile({ data: payload, labels: LABELS, createId: () => "generated" });
  const first = applyAnnotationImport({
    imageSet,
    annotations,
    plan: planAnnotationImport({ annotations, targetImages: imageSet.images }),
    importedAt: FIXED_NOW,
  });
  const second = applyAnnotationImport({
    imageSet: first,
    annotations,
    plan: planAnnotationImport({ annotations, targetImages: first.images }),
    importedAt: FIXED_NOW,
  });
  assert.deepEqual(second.images, first.images);
  assert.equal(second.currentImageId, first.currentImageId);
}

function testCurrentImageOnlyMovesToAnAppliedMatch() {
  const imageSet = makeImageSet();
  imageSet.currentImageId = "img_3";
  const annotations = {
    currentImagePath: "side/002.jpg",
    images: [
      {
        relativePath: "side/002.jpg",
        width: 1,
        height: 1,
        status: "skipped",
        contours: [],
      },
    ],
  };
  const plan = planAnnotationImport({ annotations, targetImages: imageSet.images });
  assert.equal(plan.matches.length, 0);
  assert.equal(plan.conflicts.length, 1);
  const updated = applyAnnotationImport({ imageSet, annotations, plan, importedAt: FIXED_NOW });
  assert.equal(updated.currentImageId, "img_3");
}

function testNoMatchesUsesStableErrorCode() {
  assert.throws(
    () => assertAnnotationImportHasMatches({ matches: [] }),
    (error) => {
      assert.equal(error instanceof AnnotationTransferError, true);
      assert.equal(error.code, ANNOTATION_TRANSFER_ERROR_CODES.NO_MATCHES);
      return true;
    },
  );
}

testBuildsOnePortableAnnotationFile();
testRoundTripsApplicationFormat();
testReadsReleasedAggregateAsOneWayMigration();
testNormalizesAndRejectsUnsafePaths();
testRejectsDuplicatePathsAndInvalidDoneRecord();
testRejectsDuplicateContourIds();
testPlansAndAppliesPartialImport();
testRepeatedApplyIsBusinessIdempotent();
testCurrentImageOnlyMovesToAnAppliedMatch();
testNoMatchesUsesStableErrorCode();

console.log("annotation transfer tests passed");
