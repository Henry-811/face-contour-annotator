import { MIN_ANNOTATION_IMAGE_SIDE } from "./config.js";
import { normalizePointToImage } from "./geometry.js";

const TEMPLATE_SEGMENTS = {
  eyebrow: 5,
};

function makeArc({ cx, cy, rx, ry, start, end, segments }) {
  return Array.from({ length: segments }, (_, index) => {
    const progress = segments === 1 ? 0 : index / (segments - 1);
    const angle = start + (end - start) * progress;
    return {
      x: cx + Math.cos(angle) * rx,
      y: cy + Math.sin(angle) * ry,
    };
  });
}

function makeEyeOutline({ cx, cy, rx, upperRy, lowerRy }) {
  return [
    { x: cx - rx, y: cy },
    { x: cx - rx * 0.86, y: cy - upperRy * 0.42 },
    { x: cx - rx * 0.62, y: cy - upperRy * 0.76 },
    { x: cx - rx * 0.34, y: cy - upperRy * 0.96 },
    { x: cx, y: cy - upperRy },
    { x: cx + rx * 0.34, y: cy - upperRy * 0.96 },
    { x: cx + rx * 0.62, y: cy - upperRy * 0.76 },
    { x: cx + rx * 0.86, y: cy - upperRy * 0.42 },
    { x: cx + rx, y: cy },
    { x: cx + rx * 0.84, y: cy + lowerRy * 0.5 },
    { x: cx + rx * 0.58, y: cy + lowerRy * 0.82 },
    { x: cx + rx * 0.28, y: cy + lowerRy * 0.98 },
    { x: cx, y: cy + lowerRy },
    { x: cx - rx * 0.28, y: cy + lowerRy * 0.98 },
    { x: cx - rx * 0.58, y: cy + lowerRy * 0.82 },
    { x: cx - rx * 0.84, y: cy + lowerRy * 0.5 },
  ];
}

function makeMouthOutline({ cx, cy, rx, upperRy, lowerRy }) {
  return [
    { x: cx - rx, y: cy },
    { x: cx - rx * 0.78, y: cy - upperRy * 0.45 },
    { x: cx - rx * 0.42, y: cy - upperRy * 0.95 },
    { x: cx - rx * 0.14, y: cy - upperRy * 0.6 },
    { x: cx, y: cy - upperRy * 0.82 },
    { x: cx + rx * 0.14, y: cy - upperRy * 0.6 },
    { x: cx + rx * 0.42, y: cy - upperRy * 0.95 },
    { x: cx + rx * 0.78, y: cy - upperRy * 0.45 },
    { x: cx + rx, y: cy },
    { x: cx + rx * 0.78, y: cy + lowerRy * 0.72 },
    { x: cx + rx * 0.35, y: cy + lowerRy * 1.05 },
    { x: cx, y: cy + lowerRy * 1.16 },
    { x: cx - rx * 0.35, y: cy + lowerRy * 1.05 },
    { x: cx - rx * 0.78, y: cy + lowerRy * 0.72 },
  ];
}

function makeEarOutline({ cx, cy, rx, ry, side }) {
  return [
    { x: cx + side * rx * -0.42, y: cy - ry * 0.82 },
    { x: cx + side * rx * -0.12, y: cy - ry * 0.98 },
    { x: cx + side * rx * 0.32, y: cy - ry * 0.94 },
    { x: cx + side * rx * 0.7, y: cy - ry * 0.7 },
    { x: cx + side * rx * 0.94, y: cy - ry * 0.36 },
    { x: cx + side * rx, y: cy + ry * 0.02 },
    { x: cx + side * rx * 0.86, y: cy + ry * 0.42 },
    { x: cx + side * rx * 0.58, y: cy + ry * 0.74 },
    { x: cx + side * rx * 0.22, y: cy + ry * 0.96 },
    { x: cx + side * rx * -0.18, y: cy + ry },
    { x: cx + side * rx * -0.52, y: cy + ry * 0.84 },
    { x: cx + side * rx * -0.74, y: cy + ry * 0.56 },
    { x: cx + side * rx * -0.82, y: cy + ry * 0.18 },
    { x: cx + side * rx * -0.75, y: cy - ry * 0.18 },
    { x: cx + side * rx * -0.62, y: cy - ry * 0.44 },
    { x: cx + side * rx * -0.55, y: cy - ry * 0.62 },
    { x: cx + side * rx * -0.5, y: cy - ry * 0.74 },
    { x: cx + side * rx * -0.46, y: cy - ry * 0.79 },
  ];
}

function makeMouthSeam({ cx, cy, rx, ry }) {
  return [
    { x: cx - rx, y: cy },
    { x: cx - rx * 0.65, y: cy - ry * 0.18 },
    { x: cx - rx * 0.32, y: cy - ry * 0.05 },
    { x: cx, y: cy + ry * 0.08 },
    { x: cx + rx * 0.32, y: cy - ry * 0.05 },
    { x: cx + rx * 0.65, y: cy - ry * 0.18 },
    { x: cx + rx, y: cy },
  ];
}

function scalePoint(point, imageSize) {
  return normalizePointToImage(
    {
      x: point.x * imageSize.width,
      y: point.y * imageSize.height,
    },
    imageSize,
  );
}

function makeContour({ label, closed, points }, imageSize, createId) {
  return {
    id: createId(),
    label,
    closed,
    points: points.map((point) => scalePoint(point, imageSize)),
  };
}

function buildTemplateDefinitions() {
  const eyeY = 0.44;
  const eyebrowY = 0.385;
  const leftEyeX = 0.57;
  const rightEyeX = 0.43;

  // Left/right labels are anatomical; in a frontal image, subject-left is image-right.
  return [
    {
      label: "left_eyebrow",
      closed: false,
      points: makeArc({
        cx: leftEyeX,
        cy: eyebrowY,
        rx: 0.065,
        ry: 0.025,
        start: Math.PI * 1.12,
        end: Math.PI * 1.88,
        segments: TEMPLATE_SEGMENTS.eyebrow,
      }),
    },
    {
      label: "right_eyebrow",
      closed: false,
      points: makeArc({
        cx: rightEyeX,
        cy: eyebrowY,
        rx: 0.065,
        ry: 0.025,
        start: Math.PI * 1.12,
        end: Math.PI * 1.88,
        segments: TEMPLATE_SEGMENTS.eyebrow,
      }),
    },
    {
      label: "left_eye",
      closed: true,
      points: makeEyeOutline({
        cx: leftEyeX,
        cy: eyeY,
        rx: 0.052,
        upperRy: 0.021,
        lowerRy: 0.017,
      }),
    },
    {
      label: "right_eye",
      closed: true,
      points: makeEyeOutline({
        cx: rightEyeX,
        cy: eyeY,
        rx: 0.052,
        upperRy: 0.021,
        lowerRy: 0.017,
      }),
    },
    {
      label: "nose",
      closed: false,
      points: [
        { x: 0.5, y: 0.44 },
        { x: 0.49, y: 0.51 },
        { x: 0.485, y: 0.57 },
        { x: 0.455, y: 0.61 },
        { x: 0.5, y: 0.625 },
        { x: 0.545, y: 0.61 },
      ],
    },
    {
      label: "mouth",
      closed: true,
      points: makeMouthOutline({
        cx: 0.5,
        cy: 0.69,
        rx: 0.09,
        upperRy: 0.026,
        lowerRy: 0.038,
      }),
    },
    {
      label: "mouth_seam",
      closed: false,
      points: makeMouthSeam({
        cx: 0.5,
        cy: 0.69,
        rx: 0.078,
        ry: 0.018,
      }),
    },
    {
      label: "left_ear",
      closed: true,
      points: makeEarOutline({
        cx: 0.71,
        cy: 0.515,
        rx: 0.035,
        ry: 0.115,
        side: 1,
      }),
    },
    {
      label: "right_ear",
      closed: true,
      points: makeEarOutline({
        cx: 0.29,
        cy: 0.515,
        rx: 0.035,
        ry: 0.115,
        side: -1,
      }),
    },
  ];
}

function isValidImageSize(imageSize) {
  return (
    imageSize &&
    Number.isFinite(imageSize.width) &&
    Number.isFinite(imageSize.height) &&
    imageSize.width >= MIN_ANNOTATION_IMAGE_SIDE &&
    imageSize.height >= MIN_ANNOTATION_IMAGE_SIDE
  );
}

export function buildDefaultFeatureContours({
  imageSize,
  existingContours = [],
  labels,
  createId,
}) {
  if (!isValidImageSize(imageSize)) {
    throw new Error(
      `Image must be at least ${MIN_ANNOTATION_IMAGE_SIDE} x ${MIN_ANNOTATION_IMAGE_SIDE} px before initializing feature contours.`,
    );
  }
  if (typeof createId !== "function") {
    throw new Error("A contour id factory is required.");
  }
  const allowedLabels = new Set(labels.map((label) => label.id));
  const existingLabels = new Set(existingContours.map((contour) => contour.label));
  return buildTemplateDefinitions()
    .filter((template) => allowedLabels.has(template.label))
    .filter((template) => !existingLabels.has(template.label))
    .map((template) => makeContour(template, imageSize, createId));
}
