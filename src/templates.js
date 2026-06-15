import { MIN_ANNOTATION_IMAGE_SIDE } from "./config.js";
import { normalizePointToImage } from "./geometry.js";

const TEMPLATE_SEGMENTS = {
  eye: 12,
  eyebrow: 5,
  ear: 12,
  mouth: 14,
};

function makeEllipse({ cx, cy, rx, ry, segments }) {
  return Array.from({ length: segments }, (_, index) => {
    const angle = (Math.PI * 2 * index) / segments;
    return {
      x: cx + Math.cos(angle) * rx,
      y: cy + Math.sin(angle) * ry,
    };
  });
}

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
      points: makeEllipse({
        cx: leftEyeX,
        cy: eyeY,
        rx: 0.052,
        ry: 0.024,
        segments: TEMPLATE_SEGMENTS.eye,
      }),
    },
    {
      label: "right_eye",
      closed: true,
      points: makeEllipse({
        cx: rightEyeX,
        cy: eyeY,
        rx: 0.052,
        ry: 0.024,
        segments: TEMPLATE_SEGMENTS.eye,
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
      points: makeEllipse({
        cx: 0.5,
        cy: 0.705,
        rx: 0.09,
        ry: 0.032,
        segments: TEMPLATE_SEGMENTS.mouth,
      }),
    },
    {
      label: "left_ear",
      closed: true,
      points: makeEllipse({
        cx: 0.71,
        cy: 0.515,
        rx: 0.035,
        ry: 0.115,
        segments: TEMPLATE_SEGMENTS.ear,
      }),
    },
    {
      label: "right_ear",
      closed: true,
      points: makeEllipse({
        cx: 0.29,
        cy: 0.515,
        rx: 0.035,
        ry: 0.115,
        segments: TEMPLATE_SEGMENTS.ear,
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
