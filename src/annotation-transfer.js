import {
  MAX_IMAGE_SET_ENTRIES,
  MAX_RELATIVE_PATH_LENGTH,
  MIN_CLOSED_POINTS,
  MIN_OPEN_POINTS,
} from "./config.js?v=workspace-ux-1";
import {
  buildTaskSchema,
  normalizeImportedContours,
  serializeContours,
  validateContoursForTaskSchema,
} from "./exporter.js?v=workspace-ux-1";
import { getProgress, isImageStatus } from "./project.js?v=workspace-ux-1";

export const ANNOTATION_FILE_KIND = "face-contour-annotations";
export const ANNOTATION_FILE_SCHEMA_VERSION = 2;

const LEGACY_BATCH_VERSION = "face-contour-project-v1";
const LEGACY_SINGLE_VERSION = "face-contour-annotator-v1";
const MAX_CONTOUR_ID_LENGTH = 128;

export const ANNOTATION_TRANSFER_ERROR_CODES = Object.freeze({
  INVALID_FILE: "INVALID_ANNOTATION_FILE",
  UNSUPPORTED_VERSION: "UNSUPPORTED_ANNOTATION_VERSION",
  INVALID_PATH: "INVALID_IMAGE_PATH",
  DUPLICATE_PATH: "DUPLICATE_IMAGE_PATH",
  INVALID_IMAGE: "INVALID_ANNOTATION_IMAGE",
  NO_MATCHES: "NO_ANNOTATION_MATCHES",
});

export class AnnotationTransferError extends Error {
  constructor({ code, message, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AnnotationTransferError";
    this.code = code;
  }
}

function fail({ code, message, cause }) {
  throw new AnnotationTransferError({ code, message, cause });
}

function asObject({ value, field }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_FILE,
      message: `${field} must be an object.`,
    });
  }
  return value;
}

function asNonEmptyString({ value, field, maxLength = 512 }) {
  if (typeof value !== "string" || !value.trim()) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_FILE,
      message: `${field} must be a non-empty string.`,
    });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_FILE,
      message: `${field} is longer than ${maxLength} characters.`,
    });
  }
  return normalized;
}

function asPositiveInteger({ value, field }) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_IMAGE,
      message: `${field} must be a positive integer.`,
    });
  }
  return number;
}

function asOptionalDate({ value, field }) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const text = asNonEmptyString({ value, field, maxLength: 80 });
  if (!Number.isFinite(Date.parse(text))) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_FILE,
      message: `${field} must be an ISO date.`,
    });
  }
  return text;
}

function getPathName(path) {
  return path.split("/").at(-1) || path;
}

export function normalizeAnnotationRelativePath(value) {
  const raw = asNonEmptyString({
    value,
    field: "Image relative path",
    maxLength: MAX_RELATIVE_PATH_LENGTH,
  })
    .normalize("NFC")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  if (
    raw.startsWith("/") ||
    /^[a-zA-Z]:\//.test(raw) ||
    raw.includes("\0")
  ) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_PATH,
      message: `Image path must be relative: ${raw}.`,
    });
  }
  const segments = raw.split("/").filter((segment) => segment !== "");
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_PATH,
      message: `Image path contains an unsafe segment: ${raw}.`,
    });
  }
  const path = segments.join("/");
  if (path.length > MAX_RELATIVE_PATH_LENGTH) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_PATH,
      message: `Image path is longer than ${MAX_RELATIVE_PATH_LENGTH} characters.`,
    });
  }
  return path;
}

export function stripSharedRootDirectory(paths) {
  const normalized = paths.map(normalizeAnnotationRelativePath);
  if (!normalized.length) {
    return [];
  }
  const segments = normalized.map((path) => path.split("/"));
  const sharedRoot = segments[0][0];
  const canStrip = segments.every(
    (parts) => parts.length > 1 && parts[0].toLowerCase() === sharedRoot.toLowerCase(),
  );
  return canStrip ? segments.map((parts) => parts.slice(1).join("/")) : normalized;
}

function assertUniquePaths(images) {
  const seen = new Set();
  images.forEach((image) => {
    const key = image.relativePath.toLowerCase();
    if (seen.has(key)) {
      fail({
        code: ANNOTATION_TRANSFER_ERROR_CODES.DUPLICATE_PATH,
        message: `Annotation file contains a duplicate image path: ${image.relativePath}.`,
      });
    }
    seen.add(key);
  });
}

function normalizeStatus({ value, path }) {
  if (!isImageStatus(value)) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_IMAGE,
      message: `${path} has an unknown annotation status.`,
    });
  }
  return value;
}

function assertUniqueContourIds({ contours, path }) {
  const seen = new Set();
  contours.forEach((contour) => {
    const contourId = contour?.id;
    if (
      typeof contourId !== "string" ||
      !contourId.trim() ||
      contourId.length > MAX_CONTOUR_ID_LENGTH
    ) {
      fail({
        code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_IMAGE,
        message: `${path}: every contour needs a valid ID.`,
      });
    }
    if (seen.has(contourId)) {
      fail({
        code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_IMAGE,
        message: `${path}: contour IDs must be unique within an image.`,
      });
    }
    seen.add(contourId);
  });
}

function normalizeContours({ contours, labels, imageSize, createId, path }) {
  let normalized;
  try {
    normalized = normalizeImportedContours({
      contours,
      labels,
      imageSize,
      createId,
      minOpenPoints: MIN_OPEN_POINTS,
      minClosedPoints: MIN_CLOSED_POINTS,
    });
  } catch (error) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_IMAGE,
      message: `${path}: ${error instanceof Error ? error.message : "Contours are invalid."}`,
      cause: error,
    });
  }
  assertUniqueContourIds({ contours: normalized, path });
  return normalized;
}

function normalizeImageRecord({ value, labels, createId, legacy = false }) {
  const image = asObject({ value, field: "Annotation image" });
  const relativePath = normalizeAnnotationRelativePath(
    image.relativePath || image.path || image.image?.name || image.name,
  );
  const width = asPositiveInteger({
    value: image.width ?? image.image?.width,
    field: `${relativePath} width`,
  });
  const height = asPositiveInteger({
    value: image.height ?? image.image?.height,
    field: `${relativePath} height`,
  });
  const status = normalizeStatus({
    value: image.status || (legacy ? "done" : "unlabeled"),
    path: relativePath,
  });
  if (!legacy && Array.isArray(image.contours)) {
    assertUniqueContourIds({ contours: image.contours, path: relativePath });
  }
  const contours = normalizeContours({
    contours: image.contours,
    labels,
    imageSize: { width, height },
    createId,
    path: relativePath,
  });
  if (status === "done" && contours.length === 0) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_IMAGE,
      message: `${relativePath}: done images need at least one contour.`,
    });
  }
  return {
    relativePath,
    name: getPathName(relativePath),
    width,
    height,
    status,
    contours,
    updatedAt: asOptionalDate({
      value: image.updatedAt,
      field: `${relativePath} updatedAt`,
    }),
  };
}

function normalizeLegacyBatch(data) {
  const rawPaths = data.images.map((image) => image?.path || image?.name || "");
  const normalizedPaths = stripSharedRootDirectory(rawPaths);
  return {
    name: typeof data.name === "string" ? data.name : "Imported annotations",
    currentImagePath:
      data.images.find((image) => image?.id === data.currentImageId)?.path || null,
    images: data.images.map((image, index) => ({
      ...image,
      relativePath: normalizedPaths[index],
    })),
  };
}

function getEnvelope(data) {
  const value = asObject({ value: data, field: "Annotation file" });
  if (value.kind === ANNOTATION_FILE_KIND) {
    if (![1, ANNOTATION_FILE_SCHEMA_VERSION].includes(value.schemaVersion)) {
      fail({
        code: ANNOTATION_TRANSFER_ERROR_CODES.UNSUPPORTED_VERSION,
        message: `Annotation schema version ${String(value.schemaVersion)} is not supported.`,
      });
    }
    if (value.schemaVersion === 2 && Array.isArray(value.images) && value.images.some((image) => Array.isArray(image?.contours) && image.contours.some((contour) => !contour?.curve))) {
      fail({ code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_FILE, message: "Version 2 annotations require editable curve data." });
    }
    return {
      legacy: false,
      name: value.imageSet?.name || value.name || "Imported annotations",
      currentImagePath: value.imageSet?.currentImagePath || value.currentImagePath || null,
      exportedAt: value.exportedAt,
      images: value.images,
    };
  }
  if (value.version === LEGACY_BATCH_VERSION && Array.isArray(value.images)) {
    return { legacy: true, exportedAt: null, ...normalizeLegacyBatch(value) };
  }
  if (value.version === LEGACY_SINGLE_VERSION && value.image) {
    return {
      legacy: true,
      name: "Imported annotations",
      currentImagePath: value.image.name,
      exportedAt: null,
      images: [
        {
          relativePath: value.image.name,
          width: value.image.width,
          height: value.image.height,
          status: "done",
          contours: value.contours,
        },
      ],
    };
  }
  fail({
    code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_FILE,
    message: "Choose a Face Contour Lab annotation JSON file.",
  });
}

export function parseAnnotationFile({ data, labels, createId }) {
  const envelope = getEnvelope(data);
  if (!Array.isArray(envelope.images) || envelope.images.length === 0) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_FILE,
      message: "Annotation file has no images.",
    });
  }
  if (envelope.images.length > MAX_IMAGE_SET_ENTRIES) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_FILE,
      message: `Annotation file has more than ${MAX_IMAGE_SET_ENTRIES} images.`,
    });
  }
  const images = envelope.images.map((image) =>
    normalizeImageRecord({ value: image, labels, createId, legacy: envelope.legacy }),
  );
  assertUniquePaths(images);
  let currentImagePath = null;
  if (envelope.currentImagePath) {
    const normalizedCurrentPath = normalizeAnnotationRelativePath(envelope.currentImagePath);
    const direct = images.find(
      (image) => image.relativePath.toLowerCase() === normalizedCurrentPath.toLowerCase(),
    );
    const bySuffix = envelope.legacy
      ? images.find((image) =>
          normalizedCurrentPath.toLowerCase().endsWith(`/${image.relativePath.toLowerCase()}`),
        )
      : null;
    currentImagePath = (direct || bySuffix)?.relativePath || null;
  }
  return {
    kind: ANNOTATION_FILE_KIND,
    schemaVersion: ANNOTATION_FILE_SCHEMA_VERSION,
    name: asNonEmptyString({ value: envelope.name, field: "Image-set name", maxLength: 256 }),
    currentImagePath,
    exportedAt: asOptionalDate({ value: envelope.exportedAt, field: "Exported at" }),
    images,
    legacy: envelope.legacy,
  };
}

function validateExportImage(image, labels) {
  const relativePath = normalizeAnnotationRelativePath(image.path || image.name);
  const width = asPositiveInteger({ value: image.width, field: `${relativePath} width` });
  const height = asPositiveInteger({ value: image.height, field: `${relativePath} height` });
  const status = normalizeStatus({ value: image.status, path: relativePath });
  assertUniqueContourIds({ contours: image.contours || [], path: relativePath });
  const errors = validateContoursForTaskSchema({
    contours: image.contours || [],
    labels,
    imageSize: { width, height },
    minOpenPoints: MIN_OPEN_POINTS,
    minClosedPoints: MIN_CLOSED_POINTS,
  });
  if (errors.length) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_IMAGE,
      message: `${relativePath}: ${errors[0]}`,
    });
  }
  if (status === "done" && !(image.contours || []).length) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_IMAGE,
      message: `${relativePath}: done images need at least one contour.`,
    });
  }
  return {
    relativePath,
    width,
    height,
    status,
    contours: serializeContours(image.contours || [], labels),
    updatedAt: asOptionalDate({
      value: image.updatedAt,
      field: `${relativePath} updatedAt`,
    }),
  };
}

export function buildAnnotationFile({ imageSet, labels, exportedAt = new Date().toISOString() }) {
  if (!imageSet || !Array.isArray(imageSet.images) || imageSet.images.length === 0) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_FILE,
      message: "Open an image set before exporting.",
    });
  }
  if (imageSet.images.length > MAX_IMAGE_SET_ENTRIES) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_FILE,
      message: `Image set has more than ${MAX_IMAGE_SET_ENTRIES} images.`,
    });
  }
  const images = imageSet.images.map((image) => validateExportImage(image, labels));
  assertUniquePaths(images);
  const currentImage = imageSet.images.find((image) => image.id === imageSet.currentImageId);
  return {
    kind: ANNOTATION_FILE_KIND,
    schemaVersion: ANNOTATION_FILE_SCHEMA_VERSION,
    exportedAt: asOptionalDate({ value: exportedAt, field: "Exported at" }),
    imageSet: {
      name: asNonEmptyString({
        value: imageSet.name || "Image set",
        field: "Image-set name",
        maxLength: 256,
      }),
      currentImagePath: currentImage
        ? normalizeAnnotationRelativePath(currentImage.path || currentImage.name)
        : null,
    },
    taskSchema: buildTaskSchema(labels),
    images,
    progress: getProgress(imageSet.images),
  };
}

function pathKey(value) {
  return normalizeAnnotationRelativePath(value).toLowerCase();
}

export function planAnnotationImport({ annotations, targetImages }) {
  if (!annotations?.images || !Array.isArray(targetImages)) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.INVALID_FILE,
      message: "Annotations and target images are required.",
    });
  }
  const targetsByPath = new Map();
  targetImages.forEach((image) => {
    const key = pathKey(image.path || image.name);
    if (targetsByPath.has(key)) {
      fail({
        code: ANNOTATION_TRANSFER_ERROR_CODES.DUPLICATE_PATH,
        message: `Open image set contains a duplicate path: ${image.path || image.name}.`,
      });
    }
    targetsByPath.set(key, image);
  });
  const matches = [];
  const unmatched = [];
  const conflicts = [];
  annotations.images.forEach((annotation) => {
    const target = targetsByPath.get(pathKey(annotation.relativePath));
    if (!target) {
      unmatched.push({ annotation, relativePath: annotation.relativePath });
      return;
    }
    if (target.width !== annotation.width || target.height !== annotation.height) {
      conflicts.push({
        annotation,
        target,
        relativePath: annotation.relativePath,
        message:
          `${annotation.relativePath} is ${target.width} x ${target.height}; ` +
          `the annotation file expects ${annotation.width} x ${annotation.height}.`,
      });
      return;
    }
    matches.push({ annotation, target });
  });
  const overwriteCount = matches.filter(
    ({ target }) => target.status !== "unlabeled",
  ).length;
  return {
    matches,
    unmatched,
    conflicts,
    overwriteCount,
    summary: {
      annotationImages: annotations.images.length,
      targetImages: targetImages.length,
      matched: matches.length,
      unmatched: unmatched.length,
      conflicts: conflicts.length,
      overwriteCount,
    },
  };
}

export function assertAnnotationImportHasMatches(plan) {
  if (!plan?.matches?.length) {
    fail({
      code: ANNOTATION_TRANSFER_ERROR_CODES.NO_MATCHES,
      message: "No annotation records match the open image set.",
    });
  }
  return plan;
}

function cloneContours(contours) {
  return structuredClone(contours);
}

export function applyAnnotationImport({ imageSet, annotations, plan, importedAt = new Date().toISOString() }) {
  const updatesById = new Map(plan.matches.map(({ annotation, target }) => [target.id, annotation]));
  const images = imageSet.images.map((image) => {
    const annotation = updatesById.get(image.id);
    if (!annotation) {
      return { ...image, contours: cloneContours(image.contours || []) };
    }
    const contours = cloneContours(annotation.contours);
    return {
      ...image,
      status: annotation.status,
      contours,
      selectedId: contours[0]?.id || null,
      updatedAt: annotation.updatedAt || importedAt,
    };
  });
  const currentTarget = annotations.currentImagePath
    ? images.find(
        (image) =>
          updatesById.has(image.id) &&
          pathKey(image.path || image.name) === pathKey(annotations.currentImagePath),
      )
    : null;
  return {
    ...imageSet,
    images,
    currentImageId: currentTarget?.id || imageSet.currentImageId,
    updatedAt: importedAt,
  };
}
