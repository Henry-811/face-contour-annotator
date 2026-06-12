export const LABELS = [
  { id: "face_outline", name: "face outline", color: "#d84b2a", defaultClosed: true },
  { id: "left_eye", name: "left eye", color: "#087e6b", defaultClosed: true },
  { id: "right_eye", name: "right eye", color: "#0b6fb3", defaultClosed: true },
  { id: "nose", name: "nose", color: "#d0a320", defaultClosed: false },
  { id: "mouth", name: "mouth", color: "#a33f6b", defaultClosed: true },
  { id: "left_eyebrow", name: "left eyebrow", color: "#6f5bb7", defaultClosed: false },
  { id: "right_eyebrow", name: "right eyebrow", color: "#b46a21", defaultClosed: false },
  { id: "left_ear", name: "left ear", color: "#2f8f45", defaultClosed: true },
  { id: "right_ear", name: "right ear", color: "#8a6b2c", defaultClosed: true },
];

export const MIN_OPEN_POINTS = 2;
export const MIN_CLOSED_POINTS = 3;
export const POINT_RADIUS = 5;
export const HIT_RADIUS = 10;
export const LINE_HIT_RADIUS = 18;
export const SOFT_DRAG_MIN_DISTANCE = 6;
export const SOFT_DRAG_MAX_DISTANCE = 32;
export const SOFT_DRAG_RADIUS_RATIO = 0.75;
export const DENSIFY_SPACING = 10;
export const MAX_CONTROL_HANDLES = 180;
export const DRAFT_STORAGE_KEY = "face-contour-lab-draft-v1";
export const DRAFT_DB_NAME = "face-contour-lab";
export const DRAFT_DB_VERSION = 1;
export const DRAFT_STORE_NAME = "draft-assets";
export const DRAFT_IMAGE_KEY = "current-image";
export const MAX_LEGACY_DRAFT_BYTES = 1500000;
export const DRAFT_SAVE_DELAY_MS = 200;
