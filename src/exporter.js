import { finiteNumber, normalizePointToImage } from "./geometry.js?v=workspace-ux-1";
import { contourPolyline, materializeContour, validateCurve } from "./contour-editing.js?v=workspace-ux-1";

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
  const editable = materializeContour(contour);
  return {
    id: contour.id,
    label: contour.label,
    labelName: labels.find((item) => item.id === contour.label)?.name || contour.label,
    closed: Boolean(contour.closed),
    shape_type: getShapeType(contour.closed),
    points: contourPolyline(editable),
    curve: { version: 1, anchors: editable.points, segments: editable.segments },
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
    const normalized = {
      id: typeof contour.id === "string" ? contour.id : createId(),
      label: label.id,
      closed,
      points: contour.points.map((point) => normalizeImportedPoint(point, imageSize)),
    };
    if (contour.curve !== undefined || contour.segments !== undefined) {
      const curve = contour.curve;
      if (curve && curve.version !== 1) throw new Error("Unsupported editable curve version.");
      const anchors = curve ? curve.anchors : contour.points;
      if (!Array.isArray(anchors) || anchors.length < getMinimumPoints(closed, minOpenPoints, minClosedPoints) || anchors.length > 100000 ||
          !anchors.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= imageSize.width && p.y <= imageSize.height)) {
        throw new Error("Curve anchors must be finite coordinates inside the image.");
      }
      normalized.points = anchors.map((p) => ({ ...p }));
      normalized.segments = structuredClone(curve ? curve.segments : contour.segments);
      validateCurve(normalized);
      if (normalized.segments.some((s) => [s.control1, s.control2].some((p) => Math.abs(p.x) > imageSize.width * 4 || Math.abs(p.y) > imageSize.height * 4))) {
        throw new Error("Curve controls exceed the image working range.");
      }
      if (curve) {
        const projection = contourPolyline(normalized);
        if (projection.length !== contour.points.length || projection.some((p, i) => !Number.isFinite(contour.points[i]?.x) || !Number.isFinite(contour.points[i]?.y) || Math.hypot(p.x - contour.points[i].x, p.y - contour.points[i].y) > 0.000001)) {
          throw new Error("Contour points do not match the saved editable curve.");
        }
      }
    }
    // Validate render/export complexity before any caller persists a replacement.
    // Historical anchor-only input must pass the same budget as editable v2 data.
    if (!contour.curve) contourPolyline(normalized);
    return normalized;
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
