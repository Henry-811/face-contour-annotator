import { finiteNumber, normalizePointToImage } from "./geometry.js";

export function buildAnnotationExport({ image, fileName, labels, contours }) {
  return {
    version: "face-contour-annotator-v1",
    image: image
      ? {
          name: fileName,
          width: image.naturalWidth,
          height: image.naturalHeight,
        }
      : null,
    labels: labels.map(({ id, name, defaultClosed }) => ({ id, name, defaultClosed })),
    contours: contours.map((contour) => ({
      id: contour.id,
      label: contour.label,
      labelName: labels.find((item) => item.id === contour.label)?.name || contour.label,
      closed: Boolean(contour.closed),
      shape_type: contour.closed ? "polygon" : "linestrip",
      points: contour.points.map((point) => ({
        x: Math.round(point.x),
        y: Math.round(point.y),
      })),
    })),
  };
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
  const labelIds = new Set(labels.map((label) => label.id));
  return contours.map((contour) => {
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
    return {
      id: typeof contour.id === "string" ? contour.id : createId(),
      label: labelIds.has(contour.label) ? contour.label : labels[0].id,
      closed,
      points: contour.points.map((point) => normalizeImportedPoint(point, imageSize)),
    };
  });
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
