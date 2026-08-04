export const LABELS = [
  {
    id: "face_outline",
    name: "face outline",
    color: "#d84b2a",
    defaultClosed: true,
    defaultShapeType: "polygon",
    allowedShapeTypes: ["polygon", "linestrip"],
  },
  {
    id: "left_eye",
    name: "left eye",
    color: "#087e6b",
    defaultClosed: true,
    defaultShapeType: "polygon",
    allowedShapeTypes: ["polygon"],
  },
  {
    id: "right_eye",
    name: "right eye",
    color: "#0b6fb3",
    defaultClosed: true,
    defaultShapeType: "polygon",
    allowedShapeTypes: ["polygon"],
  },
  {
    id: "nose",
    name: "nose",
    color: "#d0a320",
    defaultClosed: false,
    defaultShapeType: "linestrip",
    allowedShapeTypes: ["linestrip"],
  },
  {
    id: "mouth",
    name: "mouth",
    color: "#a33f6b",
    defaultClosed: true,
    defaultShapeType: "polygon",
    allowedShapeTypes: ["polygon", "linestrip"],
  },
  {
    id: "mouth_seam",
    name: "mouth seam",
    color: "#c85f8d",
    defaultClosed: false,
    defaultShapeType: "linestrip",
    allowedShapeTypes: ["linestrip"],
  },
  {
    id: "left_eyebrow",
    name: "left eyebrow",
    color: "#6f5bb7",
    defaultClosed: false,
    defaultShapeType: "linestrip",
    allowedShapeTypes: ["linestrip"],
  },
  {
    id: "right_eyebrow",
    name: "right eyebrow",
    color: "#b46a21",
    defaultClosed: false,
    defaultShapeType: "linestrip",
    allowedShapeTypes: ["linestrip"],
  },
  {
    id: "left_ear",
    name: "left ear",
    color: "#2f8f45",
    defaultClosed: true,
    defaultShapeType: "polygon",
    allowedShapeTypes: ["polygon"],
  },
  {
    id: "right_ear",
    name: "right ear",
    color: "#8a6b2c",
    defaultClosed: true,
    defaultShapeType: "polygon",
    allowedShapeTypes: ["polygon"],
  },
];

export const MIN_OPEN_POINTS = 2;
export const MIN_CLOSED_POINTS = 3;
export const POINT_RADIUS = 2;
export const HIT_RADIUS = 10;
export const LINE_HIT_RADIUS = 18;
export const LABEL_HIT_PADDING = 4;
export const CONTOUR_LINE_WIDTH = 1.5;
export const SELECTED_CONTOUR_LINE_WIDTH = 2.5;
export const SELECTED_CONTOUR_HALO_WIDTH = 5;
export const HANDLE_STROKE_WIDTH = 1.5;
export const DRAFT_LINE_WIDTH = 1.5;
export const DEFAULT_SOFT_RADIUS = 40;
export const SOFT_RADIUS_MIN = 4;
export const SOFT_RADIUS_MAX = 96;
export const SOFT_RADIUS_STEP = 4;
export const SOFT_DRAG_MIN_DISTANCE = 6;
export const SOFT_DRAG_MAX_DISTANCE = 32;
export const SOFT_DRAG_RADIUS_RATIO = 0.75;
export const OPEN_ENDPOINT_SOFT_RADIUS_MULTIPLIER = 2.25;
export const DENSIFY_SPACING = 10;
export const MAX_CONTROL_HANDLES = 180;
export const MIN_ANNOTATION_IMAGE_SIDE = 32;
export const IMAGE_ZOOM_STEP = 1.25;
export const MIN_IMAGE_ZOOM = 0.4;
export const MAX_IMAGE_ZOOM = 5;
export const DRAFT_STORAGE_KEY = "face-contour-lab-draft-v1";
export const DRAFT_DB_NAME = "face-contour-lab";
export const DRAFT_DB_VERSION = 3;
export const DRAFT_STORE_NAME = "draft-assets";
export const DRAFT_IMAGE_KEY = "current-image";
export const PROJECT_STORE_NAME = "projects";
export const PROJECT_IMAGE_STORE_NAME = "project-images";
export const PROJECT_IMAGE_ASSET_STORE_NAME = "project-image-assets";
export const CURRENT_PROJECT_KEY = "current-project";
export const MAX_LEGACY_DRAFT_BYTES = 1500000;
export const DRAFT_SAVE_DELAY_MS = 200;
export const MAX_ANNOTATION_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_SET_ENTRIES = 10000;
export const MAX_RELATIVE_PATH_LENGTH = 1024;
export const MAX_ZIP_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_EXPANDED_BYTES = 512 * 1024 * 1024;
export const MAX_ZIP_COMPRESSION_RATIO = 200;
export const MAX_ZIP_INFLATE_CONCURRENCY = 3;
export const ZIP_INFLATE_INPUT_CHUNK_BYTES = 16 * 1024;
// Images are stored as base64 data URLs, which turn every 3 bytes into 4 characters.
export const DATA_URL_SIZE_RATIO = 4 / 3;
// Reported quota is an estimate and project metadata needs room too, so keep a margin.
export const STORAGE_HEADROOM_RATIO = 0.9;
