import { finiteNumber, normalizePointToImage } from "./geometry.js";
import { getProgress, PROJECT_JSON_VERSION } from "./project.js";

function getShapeType(closed) {
  return closed ? "polygon" : "linestrip";
}

function getLabelShapeSchema(label) {
  const defaultShapeType =
    label.defaultShapeType || (label.defaultClosed === false ? "linestrip" : "polygon");
  const allowedShapeTypes = Array.isArray(label.allowedShapeTypes)
    ? label.allowedShapeTypes
    : [defaultShapeType];
  return {
    id: label.id,
    name: label.name,
    defaultShapeType,
    allowedShapeTypes,
  };
}

export function buildTaskSchema(labels) {
  return {
    version: 1,
    taskType: "face-contour-annotation",
    coordinateSystem: "image_pixels",
    shapeTypes: {
      polygon: {
        closed: true,
        minPoints: 3,
      },
      linestrip: {
        closed: false,
        minPoints: 2,
      },
    },
    labels: labels.map(getLabelShapeSchema),
  };
}

function serializeContour(contour, labels) {
  return {
    id: contour.id,
    label: contour.label,
    labelName: labels.find((item) => item.id === contour.label)?.name || contour.label,
    closed: Boolean(contour.closed),
    shape_type: getShapeType(contour.closed),
    points: contour.points.map((point) => ({
      x: Math.round(point.x),
      y: Math.round(point.y),
    })),
  };
}

export function buildAnnotationExport({ image, fileName, labels, contours }) {
  return {
    version: "face-contour-annotator-v1",
    taskSchema: buildTaskSchema(labels),
    image: image
      ? {
          name: fileName,
          width: image.naturalWidth,
          height: image.naturalHeight,
        }
      : null,
    labels: labels.map((label) => ({
      ...getLabelShapeSchema(label),
      defaultClosed: label.defaultClosed,
    })),
    contours: contours.map((contour) => serializeContour(contour, labels)),
  };
}

export function buildProjectExport({ project, labels }) {
  if (!project || !Array.isArray(project.images)) {
    throw new Error("A project is required for project export.");
  }
  return {
    version: PROJECT_JSON_VERSION,
    taskSchema: buildTaskSchema(labels),
    source: project.source || null,
    images: project.images.map((image) => ({
      id: image.id,
      name: image.name,
      path: image.path || image.name,
      width: image.width,
      height: image.height,
      status: image.status,
      contours: serializeContours(image.contours || [], labels),
    })),
    progress: getProgress(project.images),
    currentImageId: project.currentImageId || project.images[0]?.id || null,
  };
}

export function serializeContours(contours, labels) {
  return contours.map((contour) => serializeContour(contour, labels));
}

function normalizeImportedPoint(point, imageSize) {
  if (Array.isArray(point)) {
    return normalizePointToImage({ x: point[0], y: point[1] }, imageSize);
  }
  return normalizePointToImage(
    {
      x: point?.x,
      y: point?.y,
    },
    imageSize,
  );
}

function isValidImportedPoint(point) {
  if (Array.isArray(point)) {
    return point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]));
  }
  return point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y));
}

function getMinimumPoints(closed, minOpenPoints, minClosedPoints) {
  return closed ? minClosedPoints : minOpenPoints;
}

function getShapeName(closed) {
  return closed ? "closed shape" : "open curve";
}

function getAllowedShapeTypes(label) {
  return getLabelShapeSchema(label).allowedShapeTypes;
}

export function normalizeImportedContours({
  contours,
  labels,
  imageSize,
  createId,
  minOpenPoints = 2,
  minClosedPoints = 3,
}) {
  if (!Array.isArray(contours)) {
    throw new Error("Missing contours array.");
  }
  const labelById = new Map(labels.map((label) => [label.id, label]));
  return contours.map((contour) => {
    const label = labelById.get(contour.label);
    if (!label) {
      throw new Error(`Unknown contour label: ${contour.label}.`);
    }
    const closed =
      typeof contour.closed === "boolean"
        ? contour.closed
        : contour.shape_type === "linestrip"
          ? false
          : true;
    if (
      !Array.isArray(contour.points) ||
      contour.points.length < getMinimumPoints(closed, minOpenPoints, minClosedPoints)
    ) {
      throw new Error(`${getShapeName(closed)} does not have enough points.`);
    }
    if (!contour.points.every(isValidImportedPoint)) {
      throw new Error("Contour points must be numeric.");
    }
    const shapeType = getShapeType(closed);
    if (!getAllowedShapeTypes(label).includes(shapeType)) {
      throw new Error(`${label.name} does not allow ${shapeType} shapes.`);
    }
    return {
      id: typeof contour.id === "string" ? contour.id : createId(),
      label: label.id,
      closed,
      points: contour.points.map((point) => normalizeImportedPoint(point, imageSize)),
    };
  });
}

export function validateContoursForTaskSchema({
  contours,
  labels,
  imageSize,
  createId = () => "validation_contour",
  minOpenPoints = 2,
  minClosedPoints = 3,
}) {
  try {
    normalizeImportedContours({
      contours,
      labels,
      imageSize,
      createId,
      minOpenPoints,
      minClosedPoints,
    });
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : "Contours are not valid."];
  }
}

export function getImageSize(image) {
  if (!image) {
    return null;
  }
  return {
    width: finiteNumber(image.naturalWidth),
    height: finiteNumber(image.naturalHeight),
  };
}
