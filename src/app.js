import {
  DENSIFY_SPACING,
  DEFAULT_SOFT_RADIUS,
  DRAFT_SAVE_DELAY_MS,
  DRAFT_STORAGE_KEY,
  HIT_RADIUS,
  IMAGE_ZOOM_STEP,
  LABEL_HIT_PADDING,
  LABELS,
  LINE_HIT_RADIUS,
  MAX_CONTROL_HANDLES,
  MAX_LEGACY_DRAFT_BYTES,
  MAX_ANNOTATION_FILE_BYTES,
  MAX_IMAGE_SET_ENTRIES,
  MAX_IMAGE_ZOOM,
  MIN_ANNOTATION_IMAGE_SIDE,
  MIN_CLOSED_POINTS,
  MIN_IMAGE_ZOOM,
  MIN_OPEN_POINTS,
  OPEN_ENDPOINT_SOFT_RADIUS_MULTIPLIER,
  POINT_RADIUS,
  SOFT_DRAG_MAX_DISTANCE,
  SOFT_DRAG_MIN_DISTANCE,
  SOFT_DRAG_RADIUS_RATIO,
  SOFT_RADIUS_MAX,
  SOFT_RADIUS_MIN,
  SOFT_RADIUS_STEP,
} from "./config.js?v=local-projects-1";
import * as geometry from "./geometry.js";
import * as storage from "./storage.js?v=local-projects-1";
import {
  buildTaskSchema,
  getImageSize,
  normalizeImportedContours as normalizeImportedContourData,
  validateContoursForTaskSchema,
} from "./exporter.js?v=local-projects-1";
import {
  createAnnotationProject,
  createImageId,
  createLocalProjectKey,
  createProjectImage,
  getAdjacentImageId,
  getCurrentImage,
  getFilePath,
  getImageIndex,
  getProgress,
  hydrateProjectImages,
  isImageStatus,
  releaseProjectImageAssets,
  touchProject,
} from "./project.js?v=local-projects-1";
import {
  applyAnnotationImport,
  assertAnnotationImportHasMatches,
  buildAnnotationFile,
  normalizeAnnotationRelativePath,
  parseAnnotationFile,
  planAnnotationImport,
  stripSharedRootDirectory,
} from "./annotation-transfer.js?v=local-projects-1";
import { readImageSourcesFromZip } from "./zip-import.js?v=local-projects-1";
import { buildProjectHash, parseAppRoute } from "./routes.js?v=local-projects-1";
import {
  applyCanvasScale,
  drawAnnotationCanvas,
  getFitCanvasScale,
  getDisplayContourEntries,
  hitContourLabel,
} from "./renderer.js";
import { buildDefaultFeatureContours } from "./templates.js";
const state = {
  view: "hub",
  hubProjects: [],
  hubLibraryStatus: "idle",
  routeEpoch: 0,
  routeTransitionTail: Promise.resolve(),
  routeRetryPending: false,
  project: null,
  currentImageId: null,
  image: null,
  imageDataUrl: "",
  imagePersisted: false,
  fileName: "",
  contours: [],
  selectedId: null,
  draftPoints: [],
  hoverPoint: null,
  activeLabel: "face_outline",
  mode: "draw",
  drawClosed: true,
  softDrag: true,
  showPoints: false,
  softRadius: DEFAULT_SOFT_RADIUS,
  scale: 1,
  fitScale: 1,
  imageZoom: 1,
  spacePressed: false,
  interaction: null,
  undoStack: [],
  redoStack: [],
  draftSaveTimer: null,
  draftSaveBlocked: false,
  projectWriteTail: Promise.resolve(),
  projectGeneration: 0,
  projectDirtyRevision: 0,
  projectSavedRevision: 0,
  projectSaveInFlight: 0,
  projectSaveStatus: "idle",
  storagePersisted: null,
  projectOperationBusy: false,
  annotationImportReport: null,
};

const LEGACY_DRAFT_PROJECT_KEY = "legacy-single-image-draft";

const elements = {
  projectHubView: document.getElementById("projectHubView"),
  annotationWorkspaceView: document.getElementById("annotationWorkspaceView"),
  hubTitle: document.getElementById("hubTitle"),
  hubStorageNote: document.getElementById("hubStorageNote"),
  hubStatusText: document.getElementById("hubStatusText"),
  projectList: document.getElementById("projectList"),
  projectListEmpty: document.getElementById("projectListEmpty"),
  projectLibraryTitle: document.getElementById("projectLibraryTitle"),
  projectLibraryCount: document.getElementById("projectLibraryCount"),
  workspaceTitle: document.getElementById("workspaceTitle"),
  exitProjectButton: document.getElementById("exitProjectButton"),
  canvas: document.getElementById("annotationCanvas"),
  stageShell: document.getElementById("stageShell"),
  emptyState: document.getElementById("emptyState"),
  imageInput: document.getElementById("imageInput"),
  folderInput: document.getElementById("folderInput"),
  zipInput: document.getElementById("zipInput"),
  annotationFileInput: document.getElementById("annotationFileInput"),
  openImageButton: document.getElementById("openImageButton"),
  openFolderButton: document.getElementById("openFolderButton"),
  openZipButton: document.getElementById("openZipButton"),
  projectSummary: document.getElementById("projectSummary"),
  imageWorkflowSection: document.getElementById("imageWorkflowSection"),
  imageQueueDisclosure: document.getElementById("imageQueueDisclosure"),
  imageQueueSummary: document.getElementById("imageQueueSummary"),
  annotationControls: document.getElementById("annotationControls"),
  drawToolsSection: document.getElementById("drawToolsSection"),
  refineToolsSection: document.getElementById("refineToolsSection"),
  moreActionsDisclosure: document.getElementById("moreActionsDisclosure"),
  actionsSection: document.getElementById("actionsSection"),
  projectPosition: document.getElementById("projectPosition"),
  projectName: document.getElementById("projectName"),
  projectProgress: document.getElementById("projectProgress"),
  projectSaveState: document.getElementById("projectSaveState"),
  imageQueueList: document.getElementById("imageQueueList"),
  previousImageButton: document.getElementById("previousImageButton"),
  nextImageButton: document.getElementById("nextImageButton"),
  markDoneButton: document.getElementById("markDoneButton"),
  skipImageButton: document.getElementById("skipImageButton"),
  needsReviewButton: document.getElementById("needsReviewButton"),
  fileMeta: document.getElementById("fileMeta"),
  imageSize: document.getElementById("imageSize"),
  zoomOutButton: document.getElementById("zoomOutButton"),
  zoomInButton: document.getElementById("zoomInButton"),
  zoomFitButton: document.getElementById("zoomFitButton"),
  zoomValue: document.getElementById("zoomValue"),
  cursorMeta: document.getElementById("cursorMeta"),
  draftMeta: document.getElementById("draftMeta"),
  statusText: document.getElementById("statusText"),
  labelGrid: document.getElementById("labelGrid"),
  softDragToggle: document.getElementById("softDragToggle"),
  showPointsToggle: document.getElementById("showPointsToggle"),
  softRadiusInput: document.getElementById("softRadiusInput"),
  softRadiusValue: document.getElementById("softRadiusValue"),
  densifyButton: document.getElementById("densifyButton"),
  shapeHint: document.getElementById("shapeHint"),
  shapeModeButtons: Array.from(document.querySelectorAll(".shape-mode-button")),
  contourList: document.getElementById("contourList"),
  contourCount: document.getElementById("contourCount"),
  jsonOutput: document.getElementById("jsonOutput"),
  exportAnnotationsButton: document.getElementById("exportAnnotationsButton"),
  importAnnotationsButton: document.getElementById("importAnnotationsButton"),
  annotationImportReport: document.getElementById("annotationImportReport"),
  annotationImportSummary: document.getElementById("annotationImportSummary"),
  annotationImportIssues: document.getElementById("annotationImportIssues"),
  undoButton: document.getElementById("undoButton"),
  redoButton: document.getElementById("redoButton"),
  deleteButton: document.getElementById("deleteButton"),
  initializeTemplateButton: document.getElementById("initializeTemplateButton"),
  clearButton: document.getElementById("clearButton"),
  finishDraftButton: document.getElementById("finishDraftButton"),
  cancelDraftButton: document.getElementById("cancelDraftButton"),
};

const ctx = elements.canvas.getContext("2d");
let drawFrameId = null;
let renderedWorkspaceProjectKey;

function getCurrentImageSize() {
  return getImageSize(state.image);
}

function isAnnotatableImageSize(imageSize) {
  return (
    imageSize &&
    imageSize.width >= MIN_ANNOTATION_IMAGE_SIDE &&
    imageSize.height >= MIN_ANNOTATION_IMAGE_SIDE
  );
}

function getImageTooSmallMessage(fileName, imageSize) {
  const width = Math.round(imageSize?.width || 0);
  const height = Math.round(imageSize?.height || 0);
  return `${fileName || "Image"} is ${width} x ${height}; use images at least ${MIN_ANNOTATION_IMAGE_SIDE} x ${MIN_ANNOTATION_IMAGE_SIDE} px.`;
}

function assertAnnotatableImage(image, fileName) {
  const imageSize = getImageSize(image);
  if (!isAnnotatableImageSize(imageSize)) {
    throw new Error(getImageTooSmallMessage(fileName, imageSize));
  }
}

function assertImageDimensionsMatchRecord(image, imageRecord) {
  if (
    image.naturalWidth !== imageRecord?.width ||
    image.naturalHeight !== imageRecord?.height
  ) {
    throw new Error(
      `Stored source image dimensions no longer match ${imageRecord?.path || imageRecord?.name || "the selected image"}.`,
    );
  }
}

function canInitializeFeatureTemplate() {
  return Boolean(state.image) && isAnnotatableImageSize(getCurrentImageSize());
}

function getLabel(labelId) {
  return LABELS.find((label) => label.id === labelId) || LABELS[0];
}

function getDefaultClosed(labelId = state.activeLabel) {
  const label = getLabel(labelId);
  if (label.defaultShapeType) {
    return label.defaultShapeType === "polygon";
  }
  return label.defaultClosed;
}

function getShapeType(closed) {
  return closed ? "polygon" : "linestrip";
}

function getAllowedShapeTypes(labelId = state.activeLabel) {
  const label = getLabel(labelId);
  if (Array.isArray(label.allowedShapeTypes)) {
    return label.allowedShapeTypes;
  }
  return [getShapeType(getDefaultClosed(labelId))];
}

function isShapeAllowed(labelId, closed) {
  return getAllowedShapeTypes(labelId).includes(getShapeType(closed));
}

function normalizeClosedForLabel(labelId, preferredClosed = state.drawClosed) {
  if (isShapeAllowed(labelId, preferredClosed)) {
    return preferredClosed;
  }
  return getDefaultClosed(labelId);
}

function getDrawShapeName(closed = state.drawClosed) {
  return closed ? "closed region" : "open line";
}

function getMinimumPoints(closed) {
  return closed ? MIN_CLOSED_POINTS : MIN_OPEN_POINTS;
}

function getShapeName(closed) {
  return closed ? "closed region" : "open line";
}

function setStatus(message, isError = false) {
  const target = state.view === "hub" ? elements.hubStatusText : elements.statusText;
  target.textContent = message;
  target.style.color = isError ? "var(--hot)" : "var(--muted)";
}

function setView(view) {
  state.view = view;
  const hubVisible = view === "hub";
  elements.projectHubView.hidden = !hubVisible;
  elements.annotationWorkspaceView.hidden = hubVisible;
  document.title = hubVisible
    ? "Face Contour Lab"
    : `${state.project?.name || "Opening project"} — Face Contour Lab`;
}

function getBareLocation() {
  return `${window.location.pathname}${window.location.search}`;
}

function captureRouteRequest() {
  return {
    routeEpoch: state.routeEpoch,
    hash: window.location.hash,
  };
}

function isRouteRequestCurrent(routeRequest) {
  return (
    routeRequest?.routeEpoch === state.routeEpoch &&
    routeRequest.hash === window.location.hash
  );
}

function getProjectSourceLabel(sourceType) {
  return (
    {
      folder: "Folder",
      zip: "ZIP",
      files: "Image files",
      drop: "Image files",
      legacy: "Recovered image",
    }[sourceType] || "Image set"
  );
}

function formatProjectTimestamp(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) {
    return "Unknown edit time";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function renderProjectLibrary() {
  const projects = state.hubProjects;
  const hasReadError = state.hubLibraryStatus === "error";
  elements.projectLibraryCount.textContent = `${projects.length} ${
    projects.length === 1 ? "project" : "projects"
  }`;
  elements.projectList.innerHTML = "";
  elements.projectListEmpty.hidden = projects.length > 0 || hasReadError;
  if (hasReadError) {
    elements.projectLibraryCount.textContent = "Unavailable";
    const errorState = document.createElement("div");
    errorState.className = "project-list-empty";
    const title = document.createElement("strong");
    title.textContent = "Projects could not be read";
    const detail = document.createElement("span");
    detail.textContent = "The browser did not delete them. Refresh after closing any older app tabs.";
    errorState.append(title, detail);
    elements.projectList.appendChild(errorState);
    return;
  }
  projects.forEach((project) => {
    const progress = getProgress(project.images || []);
    const card = document.createElement("article");
    card.className = "project-card";

    const main = document.createElement("div");
    main.className = "project-card-main";
    const name = document.createElement("h3");
    name.className = "project-card-name";
    name.title = project.name || "Untitled project";
    name.textContent = project.name || "Untitled project";

    const meta = document.createElement("div");
    meta.className = "project-card-meta";
    const source = document.createElement("span");
    source.textContent = getProjectSourceLabel(project.source?.type);
    const imageCount = document.createElement("span");
    imageCount.textContent = `${progress.total} ${progress.total === 1 ? "image" : "images"}`;
    const edited = document.createElement("time");
    edited.dateTime = project.updatedAt || "";
    edited.textContent = `Edited ${formatProjectTimestamp(project.updatedAt)}`;
    meta.append(source, imageCount, edited);

    const progressLine = document.createElement("div");
    progressLine.className = "project-card-progress";
    const progressParts = [`${progress.done} done`];
    if (progress.in_progress) {
      progressParts.push(`${progress.in_progress} active`);
    }
    if (progress.needs_review) {
      progressParts.push(`${progress.needs_review} review`);
    }
    if (progress.skipped) {
      progressParts.push(`${progress.skipped} skipped`);
    }
    progressLine.textContent = progressParts.join(" · ");
    main.append(name, meta, progressLine);

    const actions = document.createElement("div");
    actions.className = "project-card-actions";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "open-project-button";
    openButton.textContent = progress.done || progress.in_progress ? "Continue" : "Open project";
    openButton.disabled = state.projectOperationBusy;
    openButton.addEventListener("click", () => navigateToProject(project.localProjectKey));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "delete-project-button";
    deleteButton.textContent = "Delete local copy";
    deleteButton.disabled = state.projectOperationBusy;
    deleteButton.setAttribute("aria-label", `Delete local copy of ${project.name || "untitled project"}`);
    deleteButton.addEventListener("click", () => deleteProjectFromHub(project));
    actions.append(openButton, deleteButton);
    card.append(main, actions);
    elements.projectList.appendChild(card);
  });
}

async function refreshProjectLibrary() {
  state.hubLibraryStatus = "loading";
  renderProjectLibrary();
  state.hubProjects = await storage.listLocalProjects();
  state.hubLibraryStatus = "ready";
  renderProjectLibrary();
}

function setProjectOperationBusy(busy) {
  state.projectOperationBusy = busy;
  updateCommandState();
  if (!busy && state.routeRetryPending) {
    state.routeRetryPending = false;
    window.queueMicrotask(() => {
      handleRouteChange().catch((error) => {
        console.error("Deferred route change could not be completed.", error);
        setStatus("Navigation could not be completed.", true);
      });
    });
  }
}

function putStoredImage(dataUrl) {
  return storage.putStoredImage(dataUrl);
}

function getStoredImage() {
  return storage.getStoredImage();
}

function deleteStoredImage() {
  return storage.deleteStoredImage();
}

function clearStoredDraft() {
  if (state.draftSaveTimer) {
    window.clearTimeout(state.draftSaveTimer);
    state.draftSaveTimer = null;
  }
  try {
    storage.removeStoredDraft(DRAFT_STORAGE_KEY);
  } catch (error) {
    console.warn("Stored draft could not be cleared.", error);
  }
  deleteStoredImage().catch((error) => {
    console.warn("Stored draft image could not be cleared.", error);
  });
}

function buildStoredDraft() {
  if (!state.image || !state.imageDataUrl) {
    return null;
  }
  return {
    version: 2,
    image: {
      name: state.fileName,
      width: state.image.naturalWidth,
      height: state.image.naturalHeight,
      stored: true,
    },
    activeLabel: state.activeLabel,
    mode: state.mode,
    drawClosed: state.drawClosed,
    softDrag: state.softDrag,
    showPoints: state.showPoints,
    softRadius: state.softRadius,
    imageZoom: state.imageZoom,
    selectedId: state.selectedId,
    contours: cloneContours(),
  };
}

async function persistDraftNow() {
  if (state.project) {
    await persistProjectNow();
    return;
  }
  if (state.draftSaveTimer) {
    window.clearTimeout(state.draftSaveTimer);
    state.draftSaveTimer = null;
  }
  if (!state.image || state.draftSaveBlocked) {
    return;
  }
  try {
    const draft = buildStoredDraft();
    if (!draft) {
      return;
    }
    if (!state.imagePersisted) {
      await putStoredImage(state.imageDataUrl);
      state.imagePersisted = true;
    }
    storage.writeStoredDraft(DRAFT_STORAGE_KEY, draft);
  } catch (error) {
    state.draftSaveBlocked = true;
    console.warn("Draft could not be saved.", error);
    setStatus("Auto-restore could not save this draft. Download JSON to keep annotations.", true);
  }
}

function scheduleDraftSave() {
  if (state.project) {
    scheduleProjectSave();
    return;
  }
  if (!state.image || state.draftSaveBlocked) {
    return;
  }
  if (state.draftSaveTimer) {
    window.clearTimeout(state.draftSaveTimer);
  }
  state.draftSaveTimer = window.setTimeout(persistDraftNow, DRAFT_SAVE_DELAY_MS);
}

function createId() {
  return `contour_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function finiteNumber(value, fallback = 0) {
  return geometry.finiteNumber(value, fallback);
}

function clampImageZoom(value) {
  return Math.max(MIN_IMAGE_ZOOM, Math.min(MAX_IMAGE_ZOOM, finiteNumber(value, 1)));
}

function getImageZoomPercent() {
  return `${Math.round(state.imageZoom * 100)}%`;
}

function updateZoomControls() {
  const hasImage = Boolean(state.image);
  const busy = state.projectOperationBusy;
  elements.zoomOutButton.disabled = busy || !hasImage || state.imageZoom <= MIN_IMAGE_ZOOM;
  elements.zoomInButton.disabled = busy || !hasImage || state.imageZoom >= MAX_IMAGE_ZOOM;
  elements.zoomFitButton.disabled = busy || !hasImage || state.imageZoom === 1;
  elements.zoomValue.textContent = hasImage ? getImageZoomPercent() : "Fit";
}

function isStageScrollable() {
  return (
    elements.stageShell.scrollWidth > elements.stageShell.clientWidth + 1 ||
    elements.stageShell.scrollHeight > elements.stageShell.clientHeight + 1
  );
}

function updateStagePanState() {
  elements.stageShell.classList.toggle("is-pannable", Boolean(state.image) && isStageScrollable());
}

function cloneContours(contours = state.contours) {
  return geometry.cloneContours(contours);
}

function getCurrentProjectImageRecord() {
  if (!state.project || !state.currentImageId) {
    return null;
  }
  return state.project.images.find((image) => image.id === state.currentImageId) || null;
}

function buildProjectPreferences() {
  return {
    activeLabel: state.activeLabel,
    mode: state.mode,
    drawClosed: state.drawClosed,
    softDrag: state.softDrag,
    showPoints: state.showPoints,
    softRadius: state.softRadius,
    imageZoom: state.imageZoom,
  };
}

function applyProjectPreferences(preferences = {}) {
  state.activeLabel = LABELS.some((label) => label.id === preferences.activeLabel)
    ? preferences.activeLabel
    : state.activeLabel;
  state.drawClosed =
    typeof preferences.drawClosed === "boolean"
      ? normalizeClosedForLabel(state.activeLabel, preferences.drawClosed)
      : getDefaultClosed(state.activeLabel);
  state.mode = preferences.mode === "refine" || preferences.mode === "edit" ? "refine" : state.mode;
  state.softDrag = typeof preferences.softDrag === "boolean" ? preferences.softDrag : state.softDrag;
  state.showPoints =
    typeof preferences.showPoints === "boolean" ? preferences.showPoints : state.showPoints;
  state.softRadius = finiteNumber(preferences.softRadius, state.softRadius);
  state.imageZoom =
    typeof preferences.imageZoom === "number"
      ? clampImageZoom(preferences.imageZoom)
      : state.imageZoom;
}

function syncCurrentProjectImage() {
  const imageRecord = getCurrentProjectImageRecord();
  if (!imageRecord || !state.image) {
    return;
  }
  imageRecord.name = imageRecord.name || state.fileName;
  imageRecord.path = imageRecord.path || state.fileName;
  imageRecord.width = state.image.naturalWidth;
  imageRecord.height = state.image.naturalHeight;
  imageRecord.contours = cloneContours();
  imageRecord.selectedId = state.selectedId;
  imageRecord.updatedAt = new Date().toISOString();
  state.project.currentImageId = imageRecord.id;
  state.project.preferences = buildProjectPreferences();
  touchProject(state.project);
}

function renderProjectSaveState() {
  if (!elements.projectSaveState) {
    return;
  }
  let message = "No local image set";
  let indicatorState = "idle";
  if (state.project) {
    if (state.projectSaveStatus === "failed" || state.draftSaveBlocked) {
      message = "Local save failed — export annotations now";
      indicatorState = "failed";
    } else if (
      state.projectSaveInFlight > 0 ||
      state.draftSaveTimer ||
      state.projectDirtyRevision > state.projectSavedRevision
    ) {
      message = "Saving locally…";
      indicatorState = "saving";
    } else {
      message = "Saved locally";
      indicatorState = "saved";
    }
    if (state.storagePersisted === false) {
      message += " · browser may clear it";
    }
  }
  elements.projectSaveState.textContent = message;
  elements.projectSaveState.dataset.state = indicatorState;
}

function setProjectSaveStatus(status) {
  state.projectSaveStatus = status;
  renderProjectSaveState();
}

function markProjectDirty() {
  if (!state.project) {
    return;
  }
  state.projectDirtyRevision += 1;
  setProjectSaveStatus(state.draftSaveBlocked ? "failed" : "pending");
}

function enqueueProjectWrite(operation) {
  const run = state.projectWriteTail.then(operation, operation);
  state.projectWriteTail = run.catch(() => undefined);
  return run;
}

function captureProjectSnapshot() {
  syncCurrentProjectImage();
  const project = structuredClone(state.project);
  return {
    generation: state.projectGeneration,
    revision: state.projectDirtyRevision,
    project,
    image: project.images.find((image) => image.id === project.currentImageId) || null,
  };
}

function queueProjectSave() {
  if (!state.project) {
    return Promise.resolve({ skipped: true });
  }
  if (state.draftSaveBlocked) {
    return Promise.reject(new Error("Local image-set saving is blocked after a write failure."));
  }
  if (state.projectDirtyRevision <= state.projectSavedRevision) {
    return state.projectWriteTail.then(() => ({ skipped: true }));
  }
  const snapshot = captureProjectSnapshot();
  state.projectSaveInFlight += 1;
  setProjectSaveStatus("saving");
  return enqueueProjectWrite(async () => {
    if (snapshot.generation !== state.projectGeneration) {
      return { stale: true };
    }
    await storage.putLocalProjectSnapshot({ project: snapshot.project, image: snapshot.image });
    return { stale: false };
  })
    .then((result) => {
      if (!result.stale && snapshot.generation === state.projectGeneration) {
        state.projectSavedRevision = Math.max(
          state.projectSavedRevision,
          snapshot.revision,
        );
      }
      return result;
    })
    .catch((error) => {
      if (snapshot.generation === state.projectGeneration) {
        state.draftSaveBlocked = true;
        setProjectSaveStatus("failed");
        console.error("Image-set snapshot could not be saved.", error);
        setStatus(
          "Local save failed. Export annotations now to keep the latest work.",
          true,
        );
      }
      throw error;
    })
    .finally(() => {
      state.projectSaveInFlight = Math.max(0, state.projectSaveInFlight - 1);
      if (!state.draftSaveBlocked) {
        setProjectSaveStatus(
          state.projectDirtyRevision > state.projectSavedRevision ? "pending" : "saved",
        );
      } else {
        renderProjectSaveState();
      }
    });
}

async function flushProjectSaves() {
  if (state.draftSaveTimer) {
    window.clearTimeout(state.draftSaveTimer);
    state.draftSaveTimer = null;
  }
  if (!state.project) {
    await state.projectWriteTail;
    return;
  }
  if (state.draftSaveBlocked) {
    throw new Error("The current image set has unsaved local changes.");
  }
  while (state.projectDirtyRevision > state.projectSavedRevision) {
    await queueProjectSave();
  }
  await state.projectWriteTail;
}

async function persistProjectNow() {
  if (state.draftSaveTimer) {
    window.clearTimeout(state.draftSaveTimer);
    state.draftSaveTimer = null;
  }
  return queueProjectSave();
}

function resetProjectSaveTracking() {
  state.projectDirtyRevision = 0;
  state.projectSavedRevision = 0;
  state.projectSaveInFlight = 0;
  state.draftSaveBlocked = false;
  setProjectSaveStatus(state.project ? "saved" : "idle");
}

function clearWorkspaceState() {
  if (state.draftSaveTimer) {
    window.clearTimeout(state.draftSaveTimer);
    state.draftSaveTimer = null;
  }
  state.projectGeneration += 1;
  state.projectWriteTail = Promise.resolve();
  state.project = null;
  state.currentImageId = null;
  state.image = null;
  state.imageDataUrl = "";
  state.imagePersisted = false;
  state.fileName = "";
  state.contours = [];
  state.selectedId = null;
  state.draftPoints = [];
  state.hoverPoint = null;
  state.activeLabel = "face_outline";
  state.mode = "draw";
  state.drawClosed = true;
  state.softDrag = true;
  state.showPoints = false;
  state.softRadius = DEFAULT_SOFT_RADIUS;
  state.scale = 1;
  state.fitScale = 1;
  state.imageZoom = 1;
  state.spacePressed = false;
  state.interaction = null;
  state.undoStack = [];
  state.redoStack = [];
  state.annotationImportReport = null;
  renderedWorkspaceProjectKey = undefined;
  resetProjectSaveTracking();
  renderAll();
}

function persistAnnotationChange() {
  if (!state.project) {
    scheduleDraftSave();
    return;
  }
  scheduleProjectSave();
}

function scheduleProjectSave() {
  if (!state.project) {
    return;
  }
  markProjectDirty();
  if (state.draftSaveBlocked) {
    return;
  }
  if (state.draftSaveTimer) {
    window.clearTimeout(state.draftSaveTimer);
  }
  state.draftSaveTimer = window.setTimeout(() => {
    state.draftSaveTimer = null;
    queueProjectSave().catch(() => undefined);
  }, DRAFT_SAVE_DELAY_MS);
  renderProjectSaveState();
}

function markCurrentImageStatus(status) {
  if (!isImageStatus(status)) {
    return;
  }
  const imageRecord = getCurrentProjectImageRecord();
  if (!imageRecord || imageRecord.status === status) {
    return;
  }
  imageRecord.status = status;
  imageRecord.updatedAt = new Date().toISOString();
  touchProject(state.project);
}

function snapshotContours() {
  return JSON.stringify(state.contours);
}

function restoreContours(snapshot) {
  state.contours = JSON.parse(snapshot);
  if (!state.contours.some((contour) => contour.id === state.selectedId)) {
    state.selectedId = state.contours[0]?.id || null;
  }
  markCurrentImageStatus("in_progress");
  persistAnnotationChange();
  renderAll();
}

function commitChange(previousSnapshot) {
  const currentSnapshot = snapshotContours();
  if (currentSnapshot === previousSnapshot) {
    return;
  }
  markCurrentImageStatus("in_progress");
  state.undoStack.push(previousSnapshot);
  state.redoStack = [];
  updateCommandState();
  persistAnnotationChange();
}

function undo() {
  if (!state.undoStack.length) {
    return;
  }
  const current = snapshotContours();
  const previous = state.undoStack.pop();
  state.redoStack.push(current);
  restoreContours(previous);
  setStatus("Undone.");
}

function redo() {
  if (!state.redoStack.length) {
    return;
  }
  const current = snapshotContours();
  const next = state.redoStack.pop();
  state.undoStack.push(current);
  restoreContours(next);
  setStatus("Redone.");
}

function clampPoint(point) {
  return geometry.clampPointToImage(point, getCurrentImageSize());
}

function normalizePoint(point) {
  return geometry.normalizePointToImage(point, getCurrentImageSize());
}

function toCanvasPoint(event) {
  const rect = elements.canvas.getBoundingClientRect();
  return clampPoint({
    x: (event.clientX - rect.left) / state.scale,
    y: (event.clientY - rect.top) / state.scale,
  });
}

function distance(a, b) {
  return geometry.distance(a, b);
}

function densifyPoints(points, closed, spacing = DENSIFY_SPACING) {
  return geometry.densifyPoints(points, closed, {
    spacing,
    imageSize: getCurrentImageSize(),
  });
}

function hitFilledContour(point) {
  return geometry.hitFilledContour(state.contours, point);
}

function hitTest(point) {
  return geometry.hitTestContours({
    contours: state.contours,
    point,
    showPoints: state.showPoints,
    scale: state.scale,
    hitRadius: HIT_RADIUS,
    lineHitRadius: LINE_HIT_RADIUS,
  });
}

function hitLabel(point) {
  const displayPoint = {
    x: point.x * state.scale,
    y: point.y * state.scale,
  };
  return hitContourLabel(
    getDisplayContourEntries({
      ctx,
      contours: state.contours,
      labels: LABELS,
      selectedId: state.selectedId,
      scale: state.scale,
      canvasWidth: elements.canvas.clientWidth,
      canvasHeight: elements.canvas.clientHeight,
    }),
    displayPoint,
    LABEL_HIT_PADDING,
  );
}

function syncSidebarHierarchy() {
  const hasProject = Boolean(state.project);
  const hasImage = Boolean(state.image);
  const projectKey = state.project?.localProjectKey || null;

  if (projectKey !== renderedWorkspaceProjectKey) {
    elements.imageQueueDisclosure.open = false;
    elements.moreActionsDisclosure.open = false;
    renderedWorkspaceProjectKey = projectKey;
  }

  elements.imageWorkflowSection.hidden = !hasProject;
  elements.annotationControls.hidden = !hasImage;
  elements.actionsSection.hidden = !hasImage;
  elements.drawToolsSection.hidden = !hasImage || state.mode !== "draw";
  elements.refineToolsSection.hidden = !hasImage || state.mode !== "refine";
}

function syncModeControls() {
  document.querySelectorAll(".mode-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === state.mode);
    button.disabled = state.projectOperationBusy;
  });
  elements.canvas.style.cursor = state.projectOperationBusy
    ? "wait"
    : state.mode === "draw"
      ? "crosshair"
      : "default";
}

function syncShapeControls() {
  elements.shapeModeButtons.forEach((button) => {
    const closed = button.dataset.shape === "closed";
    button.classList.toggle("is-active", closed === state.drawClosed);
    button.disabled = state.projectOperationBusy || !isShapeAllowed(state.activeLabel, closed);
  });
}

function setDrawClosed(closed) {
  if (!isShapeAllowed(state.activeLabel, closed)) {
    setStatus(`${getLabel(state.activeLabel).name} does not allow ${getShapeType(closed)}.`, true);
    return;
  }
  state.drawClosed = Boolean(closed);
  syncShapeControls();
  updateCommandState();
  scheduleDraftSave();
  setStatus(`Draw shape: ${getDrawShapeName()}.`);
}

function setMode(mode) {
  if (mode === "edit") {
    mode = "refine";
  }
  if (mode !== "draw" && mode !== "refine") {
    return;
  }
  state.mode = mode;
  updateCommandState();
  scheduleDraftSave();
  setStatus(
    mode === "draw"
      ? "Draw mode."
      : "Refine mode: drag labels or closed regions to move, drag contour lines to reshape.",
  );
  drawCanvas();
}

function selectContour(id) {
  state.selectedId = id;
  scheduleDraftSave();
  renderAll();
}

function deleteSelected() {
  if (!state.selectedId) {
    setStatus("No contour selected.", true);
    return;
  }
  const previous = snapshotContours();
  state.contours = state.contours.filter((contour) => contour.id !== state.selectedId);
  state.selectedId = state.contours[0]?.id || null;
  commitChange(previous);
  renderAll();
  setStatus("Selected contour deleted.");
}

function clearContours() {
  if (!state.contours.length) {
    return;
  }
  const previous = snapshotContours();
  state.contours = [];
  state.selectedId = null;
  commitChange(previous);
  renderAll();
  setStatus("All contours cleared.");
}

function finishDraft(closed = getDefaultClosed()) {
  if (!isShapeAllowed(state.activeLabel, closed)) {
    setStatus(`${getLabel(state.activeLabel).name} does not allow ${getShapeType(closed)}.`, true);
    return;
  }
  const minimumPoints = getMinimumPoints(closed);
  if (state.draftPoints.length < minimumPoints) {
    setStatus(`${getShapeName(closed)} needs at least ${minimumPoints} points.`, true);
    return;
  }
  const previous = snapshotContours();
  const points = state.draftPoints.map(normalizePoint);
  const contour = {
    id: createId(),
    label: state.activeLabel,
    closed,
    points: densifyPoints(points, closed),
  };
  state.contours.push(contour);
  state.selectedId = contour.id;
  state.draftPoints = [];
  state.hoverPoint = null;
  commitChange(previous);
  renderAll();
  setStatus(`${getShapeName(closed)} finished.`);
}

function finishDraftWithDefault() {
  finishDraft(state.drawClosed);
}

function cancelDraft() {
  if (!state.draftPoints.length) {
    return;
  }
  state.draftPoints = [];
  state.hoverPoint = null;
  renderAll();
  setStatus("Draft contour canceled.");
}

function densifySelectedContour() {
  const contour = state.contours.find((candidate) => candidate.id === state.selectedId);
  if (!contour) {
    setStatus("Select a contour before adding curve points.", true);
    return;
  }
  const previous = snapshotContours();
  contour.points = densifyPoints(contour.points, Boolean(contour.closed));
  commitChange(previous);
  renderAll();
  setStatus("Curve points added.");
}

function initializeFeatureTemplate() {
  if (!state.image) {
    setStatus("Open an image before initializing feature contours.", true);
    return;
  }
  if (!canInitializeFeatureTemplate()) {
    setStatus(getImageTooSmallMessage(state.fileName, getCurrentImageSize()), true);
    return;
  }
  let templateContours;
  try {
    templateContours = buildDefaultFeatureContours({
      imageSize: getCurrentImageSize(),
      existingContours: state.contours,
      labels: LABELS,
      createId,
    });
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : "Feature contours could not be initialized.", true);
    return;
  }
  if (!templateContours.length) {
    setStatus("All template feature contours already exist.");
    return;
  }
  const previous = snapshotContours();
  state.contours = [...state.contours, ...templateContours];
  state.selectedId = templateContours[0].id;
  state.draftPoints = [];
  state.hoverPoint = null;
  commitChange(previous);
  renderAll();
  setStatus(`${templateContours.length} template contours added.`);
}

function buildInitialFeatureTemplateContours(image) {
  return buildDefaultFeatureContours({
    imageSize: getImageSize(image),
    existingContours: [],
    labels: LABELS,
    createId,
  });
}

function updateJsonOutput() {
  if (!state.project) {
    elements.jsonOutput.value = "No image set is open.";
    return;
  }
  try {
    elements.jsonOutput.value = JSON.stringify(
      buildAnnotationFile({ imageSet: state.project, labels: LABELS }),
      null,
      2,
    );
  } catch (error) {
    elements.jsonOutput.value = error instanceof Error ? error.message : "Preview is unavailable.";
  }
}

function normalizeContoursForImage(contours, imageSize) {
  return normalizeImportedContourData({
    contours,
    labels: LABELS,
    imageSize,
    createId,
    minOpenPoints: MIN_OPEN_POINTS,
    minClosedPoints: MIN_CLOSED_POINTS,
  });
}

function updateCommandState() {
  syncSidebarHierarchy();
  syncModeControls();
  const busy = state.projectOperationBusy;
  elements.undoButton.disabled = busy || state.undoStack.length === 0;
  elements.redoButton.disabled = busy || state.redoStack.length === 0;
  elements.deleteButton.disabled = busy || !state.selectedId;
  elements.initializeTemplateButton.disabled = busy || !canInitializeFeatureTemplate();
  elements.clearButton.disabled = busy || state.contours.length === 0;
  elements.openImageButton.disabled = busy;
  elements.openFolderButton.disabled = busy;
  elements.openZipButton.disabled = busy;
  elements.projectList.querySelectorAll("button").forEach((button) => {
    button.disabled = busy;
  });
  elements.exitProjectButton.disabled = busy || !state.project;
  elements.exportAnnotationsButton.disabled = !state.project || busy;
  elements.importAnnotationsButton.disabled = !state.image || busy;
  elements.finishDraftButton.disabled =
    busy ||
    state.draftPoints.length < getMinimumPoints(state.drawClosed) ||
    !isShapeAllowed(state.activeLabel, state.drawClosed);
  elements.finishDraftButton.textContent = state.drawClosed ? "Finish Region" : "Finish Line";
  elements.cancelDraftButton.disabled = busy || state.draftPoints.length === 0;
  elements.densifyButton.disabled = busy || !state.selectedId;
  elements.shapeHint.textContent = `${getLabel(state.activeLabel).name}: ${getDrawShapeName()} mode. ${
    state.drawClosed
      ? "Enter finishes a region; clicking the first point closes it."
      : "Enter finishes a line; clicking the first point stays open."
  }`;
  elements.showPointsToggle.checked = state.showPoints;
  elements.softDragToggle.disabled = busy;
  elements.showPointsToggle.disabled = busy;
  elements.softRadiusInput.disabled = busy;
  elements.softRadiusValue.textContent = `${state.softRadius} px`;
  updateZoomControls();
  syncShapeControls();
}

function renderLabels() {
  elements.labelGrid.innerHTML = "";
  LABELS.forEach((label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "label-button";
    button.classList.toggle("is-active", label.id === state.activeLabel);
    button.dataset.label = label.id;
    button.disabled = state.projectOperationBusy;
    button.innerHTML = `<span class="swatch" style="background:${label.color}"></span><span>${label.name}</span>`;
    button.addEventListener("click", () => {
      const nextClosed = normalizeClosedForLabel(label.id);
      if (state.draftPoints.length && nextClosed !== state.drawClosed) {
        setStatus(`Finish or cancel the current ${getDrawShapeName()} before switching to ${label.name}.`, true);
        return;
      }
      state.activeLabel = label.id;
      if (!state.draftPoints.length) {
        state.drawClosed = nextClosed;
      }
      renderLabels();
      updateCommandState();
      scheduleDraftSave();
      setStatus(`Active label: ${label.name}.`);
    });
    elements.labelGrid.appendChild(button);
  });
}

function renderContourList() {
  elements.contourCount.textContent = `${state.contours.length} ${
    state.contours.length === 1 ? "contour" : "contours"
  }`;
  elements.contourList.innerHTML = "";
  if (!state.contours.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "No contours";
    elements.contourList.appendChild(empty);
    return;
  }
  state.contours.forEach((contour, index) => {
    const label = getLabel(contour.label);
    const bounds = geometry.getContourBounds(contour);
    const item = document.createElement("article");
    item.className = "contour-item";
    item.classList.toggle("is-selected", contour.id === state.selectedId);
    item.innerHTML = `
      <div class="contour-item-top">
        <span class="swatch" style="background:${label.color}"></span>
        <span class="contour-index">${String(index + 1).padStart(2, "0")}</span>
        <select aria-label="Contour label"></select>
        <button class="small-button danger" type="button" title="Delete contour">x</button>
      </div>
      <div class="contour-meta">
        <span>${contour.points.length} points</span>
        <span>${contour.closed ? "closed" : "open"}</span>
        <span>${Math.round(bounds.right - bounds.left)} x ${Math.round(bounds.bottom - bounds.top)}</span>
      </div>
    `;
    item.addEventListener("click", () => selectContour(contour.id));

    const select = item.querySelector("select");
    LABELS.forEach((labelOption) => {
      const option = document.createElement("option");
      option.value = labelOption.id;
      option.textContent = labelOption.name;
      option.selected = labelOption.id === contour.label;
      select.appendChild(option);
    });
    select.addEventListener("change", (event) => {
      const nextLabelId = event.target.value;
      if (!isShapeAllowed(nextLabelId, contour.closed)) {
        event.target.value = contour.label;
        setStatus(
          `${getLabel(nextLabelId).name} does not allow ${getShapeType(contour.closed)}.`,
          true,
        );
        return;
      }
      const previous = snapshotContours();
      contour.label = event.target.value;
      state.activeLabel = contour.label;
      state.drawClosed = normalizeClosedForLabel(contour.label, Boolean(contour.closed));
      commitChange(previous);
      renderAll();
    });

    item.querySelector(".small-button").addEventListener("click", (event) => {
      event.stopPropagation();
      const previous = snapshotContours();
      state.contours = state.contours.filter((candidate) => candidate.id !== contour.id);
      state.selectedId = state.contours[0]?.id || null;
      commitChange(previous);
      renderAll();
    });

    elements.contourList.appendChild(item);
  });
}

function getStatusLabel(status) {
  return String(status || "unlabeled").replace("_", " ");
}

function renderProjectPanel() {
  const project = state.project;
  const images = project?.images || [];
  const currentIndex = getImageIndex(project, state.currentImageId);
  const progress = getProgress(images);
  elements.projectPosition.textContent = images.length
    ? `${currentIndex + 1} / ${images.length}`
    : "0 / 0";
  elements.imageQueueSummary.textContent = `${images.length} ${images.length === 1 ? "image" : "images"}`;
  elements.projectName.textContent = project?.name || "No image set";
  elements.projectProgress.textContent = `${progress.done} done, ${progress.in_progress} active`;
  renderProjectSaveState();
  elements.previousImageButton.disabled =
    state.projectOperationBusy || !getAdjacentImageId(project, -1);
  elements.nextImageButton.disabled =
    state.projectOperationBusy || !getAdjacentImageId(project, 1);
  const hasImage = Boolean(getCurrentProjectImageRecord());
  elements.markDoneButton.disabled = state.projectOperationBusy || !hasImage;
  elements.skipImageButton.disabled = state.projectOperationBusy || !hasImage;
  elements.needsReviewButton.disabled = state.projectOperationBusy || !hasImage;
  elements.imageQueueList.innerHTML = "";
  if (!images.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "No images";
    elements.imageQueueList.appendChild(empty);
    return;
  }
  images.forEach((image) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "queue-item";
    button.disabled = state.projectOperationBusy;
    button.classList.toggle("is-active", image.id === state.currentImageId);
    const name = document.createElement("span");
    name.className = "queue-name";
    name.title = image.path || image.name;
    name.textContent = image.path || image.name;
    const badge = document.createElement("span");
    badge.className = `status-badge ${image.status}`;
    badge.textContent = getStatusLabel(image.status);
    button.append(name, badge);
    button.addEventListener("click", () => {
      switchToProjectImage(image.id);
    });
    elements.imageQueueList.appendChild(button);
  });
}

function drawCanvasNow() {
  drawFrameId = null;
  drawAnnotationCanvas({
    canvas: elements.canvas,
    ctx,
    image: state.image,
    scale: state.scale,
    contours: state.contours,
    selectedId: state.selectedId,
    draftPoints: state.draftPoints,
    hoverPoint: state.hoverPoint,
    activeLabel: state.activeLabel,
    labels: LABELS,
    showPoints: state.showPoints,
    pointRadius: POINT_RADIUS,
    maxControlHandles: MAX_CONTROL_HANDLES,
  });
}

function drawCanvas() {
  if (drawFrameId !== null) {
    return;
  }
  drawFrameId = window.requestAnimationFrame(drawCanvasNow);
}

function applyImageScale() {
  if (!state.image) {
    return;
  }
  const scale = applyCanvasScale({
    canvas: elements.canvas,
    image: state.image,
    scale: state.fitScale * state.imageZoom,
  });
  if (scale === null) {
    return;
  }
  state.scale = scale;
  updateZoomControls();
  window.requestAnimationFrame(updateStagePanState);
  drawCanvas();
}

function fitCanvas({ resetZoom = false } = {}) {
  const fitScale = getFitCanvasScale({
    stageShell: elements.stageShell,
    image: state.image,
  });
  if (fitScale === null) {
    return;
  }
  state.fitScale = fitScale;
  if (resetZoom) {
    state.imageZoom = 1;
  }
  applyImageScale();
}

function setImageZoom(zoom) {
  if (!state.image) {
    return;
  }
  const nextZoom = clampImageZoom(zoom);
  if (nextZoom === state.imageZoom) {
    return;
  }
  state.imageZoom = nextZoom;
  applyImageScale();
  scheduleDraftSave();
  setStatus(`Image zoom ${getImageZoomPercent()}.`);
}

function zoomImage(direction) {
  const factor = direction > 0 ? IMAGE_ZOOM_STEP : 1 / IMAGE_ZOOM_STEP;
  setImageZoom(state.imageZoom * factor);
}

function resetImageZoom() {
  if (!state.image) {
    return;
  }
  state.imageZoom = 1;
  fitCanvas();
  scheduleDraftSave();
  setStatus("Image fitted.");
}

function renderTopbar() {
  const hasImage = Boolean(state.image);
  const imageRecord = getCurrentProjectImageRecord();
  elements.emptyState.classList.toggle("hidden", hasImage);
  elements.fileMeta.textContent = hasImage ? imageRecord?.path || state.fileName : "No image loaded";
  elements.imageSize.textContent = hasImage
    ? `${state.image.naturalWidth} x ${state.image.naturalHeight}`
    : "0 x 0";
  elements.draftMeta.textContent = `${state.draftPoints.length} draft ${
    state.draftPoints.length === 1 ? "point" : "points"
  }`;
}

function renderAll() {
  renderLabels();
  elements.softDragToggle.checked = state.softDrag;
  elements.showPointsToggle.checked = state.showPoints;
  elements.softRadiusInput.value = String(state.softRadius);
  renderTopbar();
  renderProjectPanel();
  renderContourList();
  renderAnnotationImportReport();
  updateJsonOutput();
  updateCommandState();
  drawCanvas();
}

function configureSoftRadiusInput() {
  elements.softRadiusInput.min = String(SOFT_RADIUS_MIN);
  elements.softRadiusInput.max = String(SOFT_RADIUS_MAX);
  elements.softRadiusInput.step = String(SOFT_RADIUS_STEP);
}

function loadImageDataUrl(dataUrl, fileName, options = {}) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    setStatus("Saved image data is not valid.", true);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      if (!isAnnotatableImageSize(getImageSize(image))) {
        if (options.clearOnError) {
          clearStoredDraft();
        }
        setStatus(
          options.errorStatus || getImageTooSmallMessage(fileName, getImageSize(image)),
          true,
        );
        resolve(false);
        return;
      }
      if (options.expectedImageRecord) {
        try {
          assertImageDimensionsMatchRecord(image, options.expectedImageRecord);
        } catch (error) {
          console.error("Stored source image dimensions do not match its record.", error);
          setStatus(error.message, true);
          resolve(false);
          return;
        }
      }
      let nextContours = [];
      let templateInitialized = false;
      try {
        nextContours = Array.isArray(options.contours)
          ? normalizeContoursForImage(options.contours, getImageSize(image))
          : [];
        if (options.autoInitializeTemplate === true && nextContours.length === 0) {
          nextContours = buildInitialFeatureTemplateContours(image);
          templateInitialized = nextContours.length > 0;
        }
      } catch (error) {
        console.warn("Saved contours could not be restored.", error);
        if (options.clearOnError) {
          clearStoredDraft();
        }
        setStatus("Saved contours could not be restored.", true);
        resolve(false);
        return;
      }
      if (typeof options.beforeCommit === "function") {
        try {
          options.beforeCommit();
        } catch (error) {
          console.error("Image selection could not be committed.", error);
          setStatus("Image selection could not be committed.", true);
          resolve(false);
          return;
        }
      }
      state.image = image;
      state.imageDataUrl = dataUrl;
      state.imagePersisted = Boolean(options.imageStored);
      state.fileName = fileName || "image";
      state.contours = nextContours;
      state.selectedId = state.contours.some((contour) => contour.id === options.selectedId)
        ? options.selectedId
        : state.contours[0]?.id || null;
      state.draftPoints = [];
      state.hoverPoint = null;
      state.undoStack = [];
      state.redoStack = [];
      if (!state.project) {
        state.draftSaveBlocked = false;
      }
      state.activeLabel = LABELS.some((label) => label.id === options.activeLabel)
        ? options.activeLabel
        : state.activeLabel;
      state.drawClosed =
        typeof options.drawClosed === "boolean"
          ? normalizeClosedForLabel(state.activeLabel, options.drawClosed)
          : getDefaultClosed(state.activeLabel);
      state.mode = options.mode === "refine" || options.mode === "edit" ? "refine" : "draw";
      state.softDrag = typeof options.softDrag === "boolean" ? options.softDrag : true;
      state.showPoints = typeof options.showPoints === "boolean" ? options.showPoints : false;
      state.softRadius = finiteNumber(options.softRadius, state.softRadius);
      state.imageZoom =
        typeof options.imageZoom === "number" ? clampImageZoom(options.imageZoom) : 1;
      if (templateInitialized && typeof options.mode !== "string") {
        state.mode = "refine";
      }
      fitCanvas();
      renderAll();
      if (options.persist !== false) {
        scheduleDraftSave();
      }
      setStatus(
        options.status ||
          (templateInitialized
            ? "Template feature contours added. Use Refine to align them."
            : "Image loaded."),
      );
      resolve(true);
    };
    image.onerror = () => {
      if (options.clearOnError) {
        clearStoredDraft();
      }
      setStatus(options.errorStatus || "Image could not be loaded.", true);
      resolve(false);
    };
    image.src = dataUrl;
  });
}

function readImageFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Image file could not be read."));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image could not be decoded."));
    image.src = dataUrl;
  });
}

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "webp",
]);

function isSupportedImageFile(file) {
  const extension = String(file?.name || "").split(".").at(-1)?.toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.has(extension);
}

function naturalPathCompare(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function getImageSources(fileList, { stripSharedRoot = false } = {}) {
  const files = Array.from(fileList || []).filter(isSupportedImageFile);
  const rawPaths = files.map((file) => normalizeAnnotationRelativePath(getFilePath(file)));
  const paths = stripSharedRoot ? stripSharedRootDirectory(rawPaths) : rawPaths;
  return files
    .map((file, index) => ({ file, path: paths[index] }))
    .sort((left, right) => naturalPathCompare(left.path, right.path));
}

function findDuplicateImageSourcePath(sources) {
  const seen = new Set();
  for (const source of sources) {
    const key = source.path.toLowerCase();
    if (seen.has(key)) {
      return source.path;
    }
    seen.add(key);
  }
  return null;
}

async function createProjectImageFromSource({ source, index, localProjectKey }) {
  const { file, path } = source;
  const dataUrl = await readImageFileAsDataUrl(file);
  const image = await loadImageElement(dataUrl);
  assertAnnotatableImage(image, file.name);
  const contours = buildInitialFeatureTemplateContours(image);
  return createProjectImage({
    id: createImageId({ localProjectKey, index }),
    name: file.name,
    path,
    width: image.naturalWidth,
    height: image.naturalHeight,
    dataUrl,
    contours,
    status: "unlabeled",
  });
}

async function loadProjectImageRecord(imageRecord, options = {}) {
  if (!imageRecord) {
    return false;
  }
  const storedAsset = options.dataUrl
    ? { dataUrl: options.dataUrl }
    : imageRecord.dataUrl
    ? { dataUrl: imageRecord.dataUrl }
    : await storage.getLocalProjectImageAsset(
        state.project?.localProjectKey,
        imageRecord.id,
      );
  if (!storedAsset?.dataUrl) {
    setStatus("Stored image data is missing. Reopen the image batch to continue.", true);
    return false;
  }
  applyProjectPreferences(state.project.preferences);
  return loadImageDataUrl(storedAsset.dataUrl, imageRecord.path || imageRecord.name, {
    contours: imageRecord.contours,
    selectedId: imageRecord.selectedId,
    activeLabel: state.activeLabel,
    mode: state.mode,
    drawClosed: state.drawClosed,
    softDrag: state.softDrag,
    showPoints: state.showPoints,
    softRadius: state.softRadius,
    imageZoom: state.imageZoom,
    persist: false,
    expectedImageRecord: imageRecord,
    beforeCommit() {
      state.currentImageId = imageRecord.id;
      state.project.currentImageId = imageRecord.id;
    },
    status: options.status || `Loaded ${imageRecord.path || imageRecord.name}.`,
  });
}

async function stageProjectImageRecord(imageRecord) {
  if (!imageRecord) {
    throw new Error("The imported annotation file does not select a valid image.");
  }
  const storedAsset = imageRecord.dataUrl
    ? { dataUrl: imageRecord.dataUrl }
    : await storage.getLocalProjectImageAsset(
        state.project?.localProjectKey,
        imageRecord.id,
      );
  if (!storedAsset?.dataUrl) {
    throw new Error(`Stored source image is missing for ${imageRecord.path || imageRecord.name}.`);
  }
  let decodedImage;
  try {
    decodedImage = await loadImageElement(storedAsset.dataUrl);
  } catch (error) {
    throw new Error(
      `Stored source image could not be decoded for ${imageRecord.path || imageRecord.name}.`,
      { cause: error },
    );
  }
  assertAnnotatableImage(decodedImage, imageRecord.path || imageRecord.name);
  assertImageDimensionsMatchRecord(decodedImage, imageRecord);
  normalizeContoursForImage(imageRecord.contours || [], getImageSize(decodedImage));
  return storedAsset.dataUrl;
}

function formatGigabytes(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function getNewProjectStorageWarning(fileCount, plan) {
  const suggestion = plan.fittableCount
    ? `Import about ${plan.fittableCount} at a time instead.`
    : "Free up browser storage before importing.";
  return (
    `Browser storage may be too small for ${fileCount} images: ` +
    `needs about ${formatGigabytes(plan.requiredBytes)}, ` +
    `${formatGigabytes(plan.availableBytes)} free. ${suggestion}`
  );
}

async function planImportStorageForFiles(files) {
  try {
    const estimate = await storage.estimateStorage();
    if (!estimate) {
      return null;
    }
    return storage.planImportStorage({
      fileSizes: files.map((file) => file.size),
      usage: estimate.usage,
      quota: estimate.quota,
    });
  } catch (error) {
    // A failed estimate must not block an otherwise atomic import. The create
    // transaction still reports a real quota failure without changing the library.
    console.warn("Storage estimate failed; importing without a quota precheck.", error);
    return null;
  }
}

async function activateCreatedProject(preparedProject, successStatus, routeRequest) {
  await storage.createLocalProjectData(preparedProject);
  if (!isRouteRequestCurrent(routeRequest)) {
    // The import still commits atomically, but a newer browser navigation owns
    // the visible route. Keep its hash intact and process it after this operation.
    state.routeRetryPending = true;
    return false;
  }
  clearWorkspaceState();
  state.project = releaseProjectImageAssets(preparedProject);
  state.currentImageId = state.project.currentImageId;
  resetProjectSaveTracking();
  setView("workspace");
  window.history.pushState(null, "", buildProjectHash(preparedProject.localProjectKey));
  const currentImage = getCurrentImage(preparedProject);
  const loaded = await loadProjectImageRecord(currentImage, {
    dataUrl: currentImage?.dataUrl,
    status: successStatus,
  });
  if (!loaded) {
    console.error("The local project was stored, but its current image could not be displayed.", {
      localProjectKey: state.project.localProjectKey,
      currentImageId: state.project.currentImageId,
    });
    setStatus("Project saved locally, but its current image could not be displayed. Refresh to retry.", true);
  }
  return loaded;
}

function getFolderSourceName(fileList) {
  const firstPath = Array.from(fileList || [])
    .map((file) => file.webkitRelativePath)
    .find(Boolean);
  return firstPath?.replaceAll("\\", "/").split("/")[0] || "Image folder";
}

async function openImageSources({ sources, sourceType, name, routeRequest }) {
  if (!sources.length) {
    setStatus("Choose at least one image file.", true);
    return;
  }
  if (sources.length > MAX_IMAGE_SET_ENTRIES) {
    setStatus(`Choose no more than ${MAX_IMAGE_SET_ENTRIES} images at a time.`, true);
    return;
  }
  const duplicatePath = findDuplicateImageSourcePath(sources);
  if (duplicatePath) {
    setStatus(
      `Multiple selected images use the path ${duplicatePath}. Choose their folder so paths stay unique.`,
      true,
    );
    return;
  }
  if (state.projectOperationBusy || state.view !== "hub") {
    return;
  }
  setProjectOperationBusy(true);
  try {
    const files = sources.map((source) => source.file);
    const storagePlan = await planImportStorageForFiles(files);
    if (storagePlan && !storagePlan.fits) {
      setStatus(getNewProjectStorageWarning(files.length, storagePlan), true);
      return;
    }
    setStatus(`Creating project from ${files.length} image${files.length === 1 ? "" : "s"}…`);
    const localProjectKey = createLocalProjectKey();
    const images = [];
    for (let index = 0; index < sources.length; index += 1) {
      images.push(
        await createProjectImageFromSource({
          source: sources[index],
          index,
          localProjectKey,
        }),
      );
    }
    const preparedProject = createAnnotationProject({
      localProjectKey,
      name: name || (files.length === 1 ? files[0].name : `${files.length} images`),
      images,
      taskSchema: buildTaskSchema(LABELS),
      sourceType,
      preferences: buildProjectPreferences(),
    });
    await activateCreatedProject(
      preparedProject,
      `Project created with ${files.length} image${files.length === 1 ? "" : "s"}.`,
      routeRequest,
    );
    state.annotationImportReport = null;
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : "Project could not be created.", true);
  } finally {
    setProjectOperationBusy(false);
    renderAll();
  }
}

async function openProjectFromFiles(fileList, sourceType = "files") {
  const routeRequest = captureRouteRequest();
  let sources;
  try {
    sources = getImageSources(fileList, { stripSharedRoot: sourceType === "folder" });
  } catch (error) {
    console.error("Image paths could not be prepared.", error);
    setStatus(error instanceof Error ? error.message : "Image paths are invalid.", true);
    return;
  }
  const name =
    sourceType === "folder"
      ? getFolderSourceName(fileList)
      : sources.length === 1
        ? sources[0].file.name
        : `${sources.length} images`;
  await openImageSources({ sources, sourceType, name, routeRequest });
}

async function openProjectFromZip(file) {
  const routeRequest = captureRouteRequest();
  if (!file || state.projectOperationBusy || state.view !== "hub") {
    return;
  }
  setProjectOperationBusy(true);
  setStatus(`Reading ${file.name}…`);
  try {
    const sources = await readImageSourcesFromZip(file);
    setProjectOperationBusy(false);
    await openImageSources({
      sources,
      sourceType: "zip",
      name: file.name.replace(/\.zip$/i, "") || "Image ZIP",
      routeRequest,
    });
  } catch (error) {
    console.error("Image ZIP could not be opened.", error);
    setStatus(error instanceof Error ? error.message : "Image ZIP could not be opened.", true);
  } finally {
    setProjectOperationBusy(false);
    renderAll();
  }
}

async function switchToProjectImage(imageId) {
  if (
    state.projectOperationBusy ||
    !state.project ||
    !imageId ||
    imageId === state.currentImageId
  ) {
    return;
  }
  const imageRecord = state.project.images.find((image) => image.id === imageId);
  if (!imageRecord) {
    setStatus("Image could not be found in the current set.", true);
    return;
  }
  try {
    await persistProjectNow();
  } catch (error) {
    // The in-memory image record was synchronized before the failed write, so the
    // user can keep working while the persistent-save warning remains visible.
    console.error("Could not persist before switching images.", error);
  }
  try {
    const loaded = await loadProjectImageRecord(imageRecord);
    if (loaded) {
      scheduleDraftSave();
    }
  } catch (error) {
    console.error("Project image could not be loaded.", error);
    if (
      error?.code === "LOCAL_PROJECT_DELETED" ||
      error?.code === "STALE_LOCAL_PROJECT_WRITE"
    ) {
      state.draftSaveBlocked = true;
      setProjectSaveStatus("failed");
    }
    setStatus(
      error instanceof Error ? error.message : "Project image could not be loaded.",
      true,
    );
  }
}

async function switchAdjacentImage(direction) {
  const nextId = getAdjacentImageId(state.project, direction);
  if (!nextId) {
    return;
  }
  await switchToProjectImage(nextId);
}

function validateImageForDone(imageRecord = getCurrentProjectImageRecord()) {
  if (!imageRecord) {
    return ["No image selected."];
  }
  if (!Array.isArray(imageRecord.contours) || imageRecord.contours.length === 0) {
    return ["Done images need at least one contour. Use Skip for unusable images."];
  }
  return validateContoursForTaskSchema({
    contours: imageRecord.contours,
    labels: LABELS,
    imageSize: {
      width: imageRecord.width,
      height: imageRecord.height,
    },
    minOpenPoints: MIN_OPEN_POINTS,
    minClosedPoints: MIN_CLOSED_POINTS,
  });
}

async function setCurrentImageStatus(status) {
  if (state.projectOperationBusy) {
    return;
  }
  syncCurrentProjectImage();
  const imageRecord = getCurrentProjectImageRecord();
  if (!imageRecord) {
    setStatus("Open an image before changing status.", true);
    return;
  }
  if (status === "done") {
    const errors = validateImageForDone(imageRecord);
    if (errors.length) {
      setStatus(errors[0], true);
      return;
    }
  }
  imageRecord.status = status;
  imageRecord.updatedAt = new Date().toISOString();
  touchProject(state.project);
  scheduleProjectSave();
  renderAll();
  setStatus(`${imageRecord.path || imageRecord.name} marked ${getStatusLabel(status)}.`);
}

async function showProjectHub({ message = "Choose a project to continue.", isError = false } = {}) {
  setView("hub");
  try {
    await refreshProjectLibrary();
    setStatus(message, isError);
  } catch (error) {
    console.error("Local projects could not be listed.", error);
    state.hubProjects = [];
    state.hubLibraryStatus = "error";
    renderProjectLibrary();
    setStatus("Local projects could not be read. Their stored data was not deleted.", true);
  }
  elements.hubTitle.focus({ preventScroll: true });
}

async function openLocalProject(localProjectKey, routeEpoch = state.routeEpoch) {
  if (state.projectOperationBusy) {
    return false;
  }
  setProjectOperationBusy(true);
  setView("workspace");
  setStatus("Opening local project…");
  try {
    const project = await storage.getLocalProject(localProjectKey);
    if (routeEpoch !== state.routeEpoch) {
      return false;
    }
    if (!project) {
      throw new Error("This local project is not available in this browser.");
    }
    if (!project.localWriteToken || !Array.isArray(project.images) || !project.images.length) {
      throw new Error("This local project is incomplete and was not opened.");
    }
    const imageIds = project.images.map((image) => image.id);
    const imageRecords = await storage.getLocalProjectImageRecords(
      localProjectKey,
      imageIds,
    );
    if (routeEpoch !== state.routeEpoch) {
      return false;
    }
    const hydratedProject = hydrateProjectImages(project, imageRecords);
    clearWorkspaceState();
    state.project = releaseProjectImageAssets(hydratedProject);
    state.currentImageId = project.currentImageId || project.images[0].id;
    applyProjectPreferences(project.preferences);
    resetProjectSaveTracking();
    setView("workspace");
    const restored = await loadProjectImageRecord(getCurrentImage(state.project), {
      status: "Local project opened.",
    });
    if (!restored) {
      throw new Error("Stored project image data is missing or invalid.");
    }
    elements.workspaceTitle.focus({ preventScroll: true });
    return true;
  } catch (error) {
    if (routeEpoch !== state.routeEpoch) {
      clearWorkspaceState();
      return false;
    }
    console.error("Local project could not be opened.", error);
    clearWorkspaceState();
    window.history.replaceState(null, "", getBareLocation());
    await showProjectHub({
      message: error instanceof Error ? error.message : "Local project could not be opened.",
      isError: true,
    });
    return false;
  } finally {
    setProjectOperationBusy(false);
    renderAll();
  }
}

async function leaveCurrentProject({ updateHistory = true } = {}) {
  if (!state.project || state.projectOperationBusy) {
    return !state.project;
  }
  const routeRequest = updateHistory ? captureRouteRequest() : null;
  setProjectOperationBusy(true);
  let abandonedUnsavedChanges = false;
  try {
    try {
      await flushProjectSaves();
    } catch (error) {
      console.error("Local saves could not be flushed before exit.", error);
      const confirmed = window.confirm(
        "The latest changes are not saved in this browser. Export annotation JSON first if you need them. Exit anyway and abandon those unsaved changes?",
      );
      if (!confirmed) {
        setStatus("Exit cancelled. Export annotations or retry after local saving recovers.", true);
        return false;
      }
      abandonedUnsavedChanges = true;
    }
    clearWorkspaceState();
    if (updateHistory) {
      if (isRouteRequestCurrent(routeRequest)) {
        window.history.replaceState(null, "", getBareLocation());
      } else {
        state.routeRetryPending = true;
      }
    }
    await showProjectHub({
      message: abandonedUnsavedChanges
        ? "Exited without the unsaved in-memory changes."
        : "Project saved locally and closed.",
      isError: abandonedUnsavedChanges,
    });
    return true;
  } finally {
    setProjectOperationBusy(false);
  }
}

async function exitCurrentProject() {
  await leaveCurrentProject({ updateHistory: true });
}

async function navigateToProject(localProjectKey) {
  if (state.projectOperationBusy) {
    return;
  }
  window.history.pushState(null, "", buildProjectHash(localProjectKey));
  await handleRouteChange();
}

async function deleteProjectFromHub(project) {
  if (state.projectOperationBusy || state.view !== "hub") {
    return;
  }
  const name = project.name || "Untitled project";
  const confirmed = window.confirm(
    `Delete the local copy of “${name}”? This removes its images and annotations from this browser only. Original files and exported JSON are not affected.`,
  );
  if (!confirmed) {
    setStatus("Project deletion cancelled.");
    return;
  }
  const deletedIndex = state.hubProjects.findIndex(
    (candidate) => candidate.localProjectKey === project.localProjectKey,
  );
  let restoreFocus = false;
  setProjectOperationBusy(true);
  try {
    const deleted = await storage.deleteLocalProject(project.localProjectKey);
    state.hubProjects = state.hubProjects.filter(
      (candidate) => candidate.localProjectKey !== project.localProjectKey,
    );
    state.hubLibraryStatus = "ready";
    renderProjectLibrary();
    restoreFocus = true;
    try {
      await refreshProjectLibrary();
      setStatus(
        deleted ? `Deleted the local copy of ${name}.` : `${name} was already removed.`,
      );
    } catch (refreshError) {
      console.error("Project list could not be refreshed after deletion.", refreshError);
      state.hubLibraryStatus = "ready";
      renderProjectLibrary();
      setStatus(
        `Deleted the local copy of ${name}, but the project list could not be refreshed.`,
        true,
      );
    }
  } catch (error) {
    console.error("Local project could not be deleted.", error);
    setStatus("Project could not be deleted. Its local copy was kept.", true);
  } finally {
    setProjectOperationBusy(false);
    renderProjectLibrary();
    if (restoreFocus) {
      const openButtons = elements.projectList.querySelectorAll(".open-project-button");
      const focusTarget = openButtons[Math.min(Math.max(deletedIndex, 0), openButtons.length - 1)];
      (focusTarget || elements.projectLibraryTitle).focus({ preventScroll: true });
    }
  }
}

async function applyRouteChange(routeEpoch) {
  if (routeEpoch !== state.routeEpoch) {
    return;
  }
  if (state.projectOperationBusy) {
    state.routeRetryPending = true;
    return;
  }
  const route = parseAppRoute(window.location.hash);
  if (route.name === "project") {
    if (
      state.project?.localProjectKey === route.localProjectKey &&
      state.view === "workspace"
    ) {
      return;
    }
    if (state.project) {
      const previousKey = state.project.localProjectKey;
      const left = await leaveCurrentProject({ updateHistory: false });
      if (!left) {
        window.history.replaceState(null, "", buildProjectHash(previousKey));
        return;
      }
    }
    if (routeEpoch !== state.routeEpoch) {
      return;
    }
    await openLocalProject(route.localProjectKey, routeEpoch);
    return;
  }
  if (state.project) {
    const previousKey = state.project.localProjectKey;
    const left = await leaveCurrentProject({ updateHistory: false });
    if (!left) {
      window.history.replaceState(null, "", buildProjectHash(previousKey));
      return;
    }
  }
  if (routeEpoch !== state.routeEpoch) {
    return;
  }
  if (route.name === "not-found") {
    window.history.replaceState(null, "", getBareLocation());
    await showProjectHub({ message: "That local project link is not valid.", isError: true });
    return;
  }
  await showProjectHub();
}

function handleRouteChange() {
  const routeEpoch = state.routeEpoch + 1;
  state.routeEpoch = routeEpoch;
  const transition = state.routeTransitionTail.then(
    () => applyRouteChange(routeEpoch),
    () => applyRouteChange(routeEpoch),
  );
  state.routeTransitionTail = transition.catch(() => undefined);
  return transition;
}

async function cleanupLegacyDraft() {
  try {
    storage.removeStoredDraft(DRAFT_STORAGE_KEY);
  } catch (error) {
    console.warn("Legacy draft metadata could not be cleared after migration.", error);
  }
  try {
    await deleteStoredImage();
  } catch (error) {
    console.warn("Legacy draft image could not be cleared after migration.", error);
  }
}

async function migrateLegacySingleImageDraft() {
  const raw = storage.readStoredDraft(DRAFT_STORAGE_KEY);
  if (!raw) {
    return { migrated: false };
  }
  const existingProject = await storage.getLocalProject(LEGACY_DRAFT_PROJECT_KEY);
  if (existingProject) {
    await cleanupLegacyDraft();
    return { migrated: false, alreadyMigrated: true };
  }
  if (raw.length > MAX_LEGACY_DRAFT_BYTES && raw.includes('"src"')) {
    throw new Error("A large legacy single-image draft was kept but could not be migrated automatically.");
  }
  const draft = JSON.parse(raw);
  let dataUrl;
  if (draft?.version === 1 && typeof draft.image?.src === "string") {
    dataUrl = draft.image.src;
  } else if (draft?.version === 2 && draft.image?.stored) {
    const storedImage = await getStoredImage();
    dataUrl = storedImage?.dataUrl;
  } else {
    throw new Error("A legacy single-image draft has an unsupported format.");
  }
  if (!dataUrl) {
    throw new Error("A legacy single-image draft is missing its source image.");
  }
  const decodedImage = await loadImageElement(dataUrl);
  assertAnnotatableImage(decodedImage, draft.image?.name);
  const imageSize = getImageSize(decodedImage);
  const contours = normalizeContoursForImage(draft.contours || [], imageSize);
  const image = createProjectImage({
    id: createImageId({ localProjectKey: LEGACY_DRAFT_PROJECT_KEY, index: 0 }),
    name: draft.image?.name || "Recovered image",
    path: draft.image?.name || "Recovered image",
    width: decodedImage.naturalWidth,
    height: decodedImage.naturalHeight,
    dataUrl,
    contours,
    status: contours.length ? "in_progress" : "unlabeled",
  });
  image.selectedId = contours.some((contour) => contour.id === draft.selectedId)
    ? draft.selectedId
    : contours[0]?.id || null;
  const project = createAnnotationProject({
    localProjectKey: LEGACY_DRAFT_PROJECT_KEY,
    name: draft.image?.name || "Recovered image",
    images: [image],
    taskSchema: buildTaskSchema(LABELS),
    sourceType: "legacy",
    preferences: {
      activeLabel: draft.activeLabel,
      mode: draft.mode,
      drawClosed: draft.drawClosed,
      softDrag: draft.softDrag,
      showPoints: draft.showPoints,
      softRadius: draft.softRadius,
      imageZoom: draft.imageZoom,
    },
  });
  await storage.createLocalProjectData(project);
  await cleanupLegacyDraft();
  return { migrated: true, localProjectKey: LEGACY_DRAFT_PROJECT_KEY };
}

function clampMoveDelta(contours, dx, dy) {
  if (!state.image || !contours.length) {
    return { dx, dy };
  }
  return geometry.clampMoveDelta(contours, dx, dy, getCurrentImageSize());
}

function moveContourPoints(points, dx, dy) {
  return geometry.moveContourPoints(points, dx, dy, getCurrentImageSize());
}

function startStagePan(event, captureTarget) {
  if (!state.image || !isStageScrollable()) {
    return false;
  }
  event.preventDefault();
  captureTarget.setPointerCapture?.(event.pointerId);
  state.interaction = {
    type: "pan",
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startScrollLeft: elements.stageShell.scrollLeft,
    startScrollTop: elements.stageShell.scrollTop,
  };
  elements.stageShell.classList.add("is-panning");
  return true;
}

function updateStagePan(event, interaction) {
  const dx = event.clientX - interaction.startClientX;
  const dy = event.clientY - interaction.startClientY;
  elements.stageShell.scrollLeft = interaction.startScrollLeft - dx;
  elements.stageShell.scrollTop = interaction.startScrollTop - dy;
}

function finishStagePan(event) {
  if (elements.canvas.hasPointerCapture?.(event.pointerId)) {
    elements.canvas.releasePointerCapture(event.pointerId);
  }
  if (elements.stageShell.hasPointerCapture?.(event.pointerId)) {
    elements.stageShell.releasePointerCapture(event.pointerId);
  }
  state.interaction = null;
  elements.stageShell.classList.remove("is-panning");
  updateStagePanState();
}

function shouldPanCanvas(event) {
  return event.button === 1 || (event.button === 0 && state.spacePressed);
}

function handleDrawPointerDown(point) {
  const firstPoint = state.draftPoints[0];
  if (
    state.drawClosed &&
    firstPoint &&
    state.draftPoints.length >= MIN_CLOSED_POINTS &&
    distance(point, firstPoint) <= HIT_RADIUS / state.scale
  ) {
    finishDraft(true);
    return;
  }
  state.draftPoints.push(point);
  state.hoverPoint = point;
  renderAll();
  setStatus("Point added.");
}

function applySoftMove(interaction, point) {
  const result = geometry.applySoftMoveToContours({
    contours: interaction.startContours,
    contourId: interaction.contourId,
    interaction,
    point,
    softRadius: state.softRadius,
    imageSize: getCurrentImageSize(),
    softDragConfig: {
      minDistance: SOFT_DRAG_MIN_DISTANCE,
      maxDistance: SOFT_DRAG_MAX_DISTANCE,
      radiusRatio: SOFT_DRAG_RADIUS_RATIO,
      endpointRadiusMultiplier: OPEN_ENDPOINT_SOFT_RADIUS_MULTIPLIER,
    },
  });
  interaction.wasClamped = result.wasClamped;
  state.contours = result.contours;
}

function handleRefinePointerDown(point, event) {
  const labelHit = hitLabel(point);
  const hit = labelHit || (event?.shiftKey
    ? hitFilledContour(point) || hitTest(point)
    : hitTest(point));
  if (!hit) {
    state.selectedId = null;
    if (!startStagePan(event, elements.canvas)) {
      state.interaction = null;
    }
    renderAll();
    return;
  }
  const previousSnapshot = snapshotContours();
  state.selectedId = hit.contour.id;
  if (hit.type === "label" || hit.type === "contour") {
    state.interaction = {
      type: "move",
      previousSnapshot,
      contourId: hit.contour.id,
      startPoint: point,
      startContours: cloneContours(),
    };
  } else if (hit.type === "vertex" && !state.softDrag) {
    state.interaction = {
      type: "vertex",
      previousSnapshot,
      contourId: hit.contour.id,
      pointIndex: hit.pointIndex,
    };
  } else if (hit.type === "vertex" || hit.type === "edge") {
    state.interaction = {
      type: "soft",
      previousSnapshot,
      contourId: hit.contour.id,
      pointIndex: hit.pointIndex,
      segmentIndex: hit.segmentIndex,
      segmentT: hit.segmentT || 0,
      startPoint: point,
      startContours: cloneContours(),
    };
  } else if (event?.shiftKey) {
    state.interaction = {
      type: "move",
      previousSnapshot,
      contourId: hit.contour.id,
      startPoint: point,
      startContours: cloneContours(),
    };
  } else {
    state.interaction = null;
    renderAll();
    setStatus("Drag the label or closed region to move it. Drag the contour line to reshape.");
    return;
  }
  renderAll();
}

function handlePointerDown(event) {
  if (state.projectOperationBusy || !state.image) {
    return;
  }
  if (shouldPanCanvas(event) && startStagePan(event, elements.canvas)) {
    return;
  }
  if (event.button !== 0) {
    return;
  }
  elements.canvas.setPointerCapture(event.pointerId);
  const point = toCanvasPoint(event);
  if (state.mode === "draw") {
    handleDrawPointerDown(point);
  } else {
    handleRefinePointerDown(point, event);
  }
}

function handlePointerMove(event) {
  if (!state.image) {
    return;
  }
  if (state.interaction?.type === "pan") {
    updateStagePan(event, state.interaction);
    return;
  }
  const point = toCanvasPoint(event);
  elements.cursorMeta.textContent = `x ${Math.round(point.x)}, y ${Math.round(point.y)}`;
  if (state.mode === "draw") {
    state.hoverPoint = point;
    drawCanvas();
    return;
  }

  const interaction = state.interaction;
  if (!interaction) {
    const moveHit = event.shiftKey ? hitFilledContour(point) : null;
    const hit = hitLabel(point) || moveHit || hitTest(point);
    if (hit?.type === "vertex" || hit?.type === "edge") {
      elements.canvas.style.cursor = "grab";
    } else if (hit?.type === "label" || hit?.type === "contour") {
      elements.canvas.style.cursor = "move";
    } else {
      elements.canvas.style.cursor = "default";
    }
    return;
  }

  if (interaction.type === "vertex") {
    const contour = state.contours.find((candidate) => candidate.id === interaction.contourId);
    if (contour) {
      contour.points[interaction.pointIndex] = point;
      drawCanvas();
    }
    return;
  }

  if (interaction.type === "soft") {
    applySoftMove(interaction, point);
    drawCanvas();
    return;
  }

  if (interaction.type === "move") {
    const rawDx = point.x - interaction.startPoint.x;
    const rawDy = point.y - interaction.startPoint.y;
    const targets = interaction.startContours.filter(
      (contour) => contour.id === interaction.contourId,
    );
    const { dx, dy } = clampMoveDelta(targets, rawDx, rawDy);
    state.contours = interaction.startContours.map((contour) => {
      if (contour.id === interaction.contourId) {
        return { ...contour, points: moveContourPoints(contour.points, dx, dy) };
      }
      return {
        ...contour,
        points: contour.points.map((item) => ({ ...item })),
      };
    });
    drawCanvas();
  }
}

function handlePointerUp(event) {
  if (elements.canvas.hasPointerCapture?.(event.pointerId)) {
    elements.canvas.releasePointerCapture(event.pointerId);
  }
  if (state.interaction?.type === "pan") {
    finishStagePan(event);
    return;
  }
  if (!state.interaction) {
    return;
  }
  const interaction = state.interaction;
  commitChange(interaction.previousSnapshot);
  state.interaction = null;
  renderAll();
  const message =
    interaction.type === "vertex"
      ? "Vertex moved."
      : interaction.type === "soft"
        ? interaction.wasClamped
          ? "Curve refined. Large drag limited."
          : "Curve refined."
        : "Contour moved.";
  setStatus(message);
}

function handleStagePointerDown(event) {
  if (
    state.projectOperationBusy ||
    event.target !== elements.stageShell ||
    event.button !== 0
  ) {
    return;
  }
  startStagePan(event, elements.stageShell);
}

function handleStagePointerMove(event) {
  if (state.interaction?.type !== "pan") {
    return;
  }
  updateStagePan(event, state.interaction);
}

function handleStagePointerUp(event) {
  if (state.interaction?.type !== "pan") {
    return;
  }
  finishStagePan(event);
}

function getDownloadBaseName({ name, fallback = "face-contour-annotations" }) {
  const normalized = String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || fallback;
}

function downloadJsonPayload(payload, fileName) {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function readJsonFile(file) {
  if (!file) {
    return null;
  }
  if (file.size > MAX_ANNOTATION_FILE_BYTES) {
    throw new Error(
      `JSON file is too large. The limit is ${Math.round(MAX_ANNOTATION_FILE_BYTES / 1024 / 1024)} MB.`,
    );
  }
  let text;
  try {
    text = await file.text();
  } catch (error) {
    throw new Error("JSON file could not be read.", { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("The selected file is not valid JSON.", { cause: error });
  }
}

async function exportAnnotations() {
  if (!state.project || state.projectOperationBusy) {
    setStatus("Open an image set before exporting annotations.", true);
    return;
  }
  setProjectOperationBusy(true);
  updateCommandState();
  const startedAt = performance.now();
  let localSaveFailed = false;
  try {
    try {
      await flushProjectSaves();
    } catch (error) {
      localSaveFailed = true;
      console.error("Local save could not be flushed before annotation export.", error);
    }
    syncCurrentProjectImage();
    const payload = buildAnnotationFile({ imageSet: state.project, labels: LABELS });
    const fileName =
      getDownloadBaseName({ name: state.project.name, fallback: "annotations" }) +
      ".face-contour-annotations.json";
    downloadJsonPayload(payload, fileName);
    console.info("Annotation export completed.", {
      imageCount: payload.images.length,
      durationMs: Math.round(performance.now() - startedAt),
      localSaveFailed,
    });
    setStatus(
      localSaveFailed
        ? fileName + " exported, but browser auto-save is still failing."
        : fileName + " exported with " + payload.images.length + " images.",
      localSaveFailed,
    );
  } catch (error) {
    console.error("Annotations could not be exported.", error);
    setStatus(error instanceof Error ? error.message : "Annotations could not be exported.", true);
  } finally {
    setProjectOperationBusy(false);
    renderAll();
  }
}

function renderAnnotationImportReport() {
  const report = state.annotationImportReport;
  if (!elements.annotationImportReport) {
    return;
  }
  elements.annotationImportReport.hidden = !report;
  elements.annotationImportIssues.innerHTML = "";
  if (!report) {
    elements.annotationImportSummary.textContent = "";
    return;
  }
  const summary = report.summary;
  elements.annotationImportSummary.textContent =
    String(summary.matched) +
    " applied · " +
    String(summary.unmatched) +
    " unmatched · " +
    String(summary.conflicts) +
    " conflicts";
  const issues = [
    ...report.unmatched.map((issue) => ({
      title: "Unmatched",
      path: issue.relativePath,
      message: "No image in the open set uses this relative path.",
    })),
    ...report.conflicts.map((issue) => ({
      title: "Conflict",
      path: issue.relativePath,
      message: issue.message,
    })),
  ];
  elements.annotationImportReport.open = issues.length > 0;
  issues.slice(0, 100).forEach((issue) => {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = issue.title + ": " + issue.path;
    const message = document.createElement("span");
    message.textContent = issue.message;
    item.append(title, message);
    elements.annotationImportIssues.appendChild(item);
  });
  if (issues.length > 100) {
    const item = document.createElement("li");
    item.textContent = String(issues.length - 100) + " more issues not shown.";
    elements.annotationImportIssues.appendChild(item);
  }
}

async function replaceActiveAnnotations(preparedImageSet) {
  const preparedCurrentImage = getCurrentImage(preparedImageSet);
  const stagedDataUrl = await stageProjectImageRecord(preparedCurrentImage);
  if (state.draftSaveTimer) {
    window.clearTimeout(state.draftSaveTimer);
    state.draftSaveTimer = null;
  }
  await state.projectWriteTail;
  state.projectGeneration += 1;
  await enqueueProjectWrite(() => storage.replaceLocalProjectAnnotations(preparedImageSet));
  state.project = preparedImageSet;
  resetProjectSaveTracking();
  const loaded = await loadProjectImageRecord(preparedCurrentImage, {
    dataUrl: stagedDataUrl,
    status: "Annotations imported.",
  });
  if (!loaded) {
    state.project.currentImageId = state.currentImageId;
    throw new Error("Annotations were saved, but the current image could not be displayed.");
  }
}

async function importAnnotations(file) {
  if (!file || state.projectOperationBusy) {
    return;
  }
  if (!state.project) {
    setStatus("Open the matching image folder or ZIP before importing annotations.", true);
    return;
  }
  setProjectOperationBusy(true);
  state.annotationImportReport = null;
  renderAnnotationImportReport();
  updateCommandState();
  setStatus("Checking annotation file…");
  const startedAt = performance.now();
  try {
    await flushProjectSaves();
    syncCurrentProjectImage();
    const data = await readJsonFile(file);
    const annotations = parseAnnotationFile({ data, labels: LABELS, createId });
    const plan = planAnnotationImport({
      annotations,
      targetImages: state.project.images,
    });
    if (!plan.matches.length) {
      state.annotationImportReport = {
        summary: plan.summary,
        unmatched: plan.unmatched,
        conflicts: plan.conflicts,
      };
      assertAnnotationImportHasMatches(plan);
    }
    if (
      plan.overwriteCount > 0 &&
      !window.confirm(
        "Import annotations and replace existing work on " +
          plan.overwriteCount +
          " matching image" +
          (plan.overwriteCount === 1 ? "" : "s") +
          "?",
      )
    ) {
      setStatus("Annotation import cancelled.");
      return;
    }
    const preparedImageSet = applyAnnotationImport({
      imageSet: state.project,
      annotations,
      plan,
    });
    await replaceActiveAnnotations(preparedImageSet);
    state.annotationImportReport = {
      summary: plan.summary,
      unmatched: plan.unmatched,
      conflicts: plan.conflicts,
    };
    console.info("Annotation import completed.", {
      matched: plan.summary.matched,
      unmatched: plan.summary.unmatched,
      conflicts: plan.summary.conflicts,
      legacyMigration: annotations.legacy,
      durationMs: Math.round(performance.now() - startedAt),
    });
    const partial = plan.unmatched.length > 0 || plan.conflicts.length > 0;
    setStatus(
      String(plan.matches.length) +
        " image" +
        (plan.matches.length === 1 ? "" : "s") +
        " updated" +
        (partial ? "; review the import report." : "."),
      false,
    );
  } catch (error) {
    console.error("Annotations could not be imported.", error);
    setStatus(error instanceof Error ? error.message : "Annotations could not be imported.", true);
  } finally {
    setProjectOperationBusy(false);
    renderAll();
  }
}
/**
 * True while annotations exist only in memory or a local write is in flight.
 * Both single-image and image-set paths share `draftSaveTimer`.
 */
function hasUnsavedAnnotationWork() {
  return Boolean(
    state.draftSaveTimer ||
      state.draftSaveBlocked ||
      state.projectSaveInFlight > 0 ||
      state.projectDirtyRevision > state.projectSavedRevision,
  );
}

function handleBeforeUnload(event) {
  if (!hasUnsavedAnnotationWork()) {
    return;
  }
  event.preventDefault();
  // Chrome only shows the confirmation dialog when returnValue is set; the wording itself
  // is fixed by the browser and cannot be customized.
  event.returnValue = "";
}

function isInteractiveShortcutTarget(target) {
  return Boolean(
    target instanceof Element &&
      target.closest(
        "button, input, textarea, select, summary, a[href], [contenteditable], dialog",
      ),
  );
}

function wireEvents() {
  elements.openImageButton.addEventListener("click", () => elements.imageInput.click());
  elements.openFolderButton.addEventListener("click", () => elements.folderInput.click());
  elements.openZipButton.addEventListener("click", () => elements.zipInput.click());
  elements.exitProjectButton.addEventListener("click", exitCurrentProject);
  elements.imageInput.addEventListener("change", (event) => {
    openProjectFromFiles(event.target.files, "files");
    event.target.value = "";
  });
  elements.folderInput.addEventListener("change", (event) => {
    openProjectFromFiles(event.target.files, "folder");
    event.target.value = "";
  });
  elements.zipInput.addEventListener("change", (event) => {
    openProjectFromZip(event.target.files[0]);
    event.target.value = "";
  });
  elements.exportAnnotationsButton.addEventListener("click", exportAnnotations);
  elements.importAnnotationsButton.addEventListener("click", () =>
    elements.annotationFileInput.click(),
  );
  elements.annotationFileInput.addEventListener("change", (event) => {
    importAnnotations(event.target.files[0]);
    event.target.value = "";
  });
  elements.previousImageButton.addEventListener("click", () => {
    switchAdjacentImage(-1);
  });
  elements.nextImageButton.addEventListener("click", () => {
    switchAdjacentImage(1);
  });
  elements.markDoneButton.addEventListener("click", () => {
    setCurrentImageStatus("done");
  });
  elements.skipImageButton.addEventListener("click", () => {
    setCurrentImageStatus("skipped");
  });
  elements.needsReviewButton.addEventListener("click", () => {
    setCurrentImageStatus("needs_review");
  });
  elements.undoButton.addEventListener("click", undo);
  elements.redoButton.addEventListener("click", redo);
  elements.deleteButton.addEventListener("click", deleteSelected);
  elements.initializeTemplateButton.addEventListener("click", initializeFeatureTemplate);
  elements.clearButton.addEventListener("click", clearContours);
  elements.finishDraftButton.addEventListener("click", finishDraftWithDefault);
  elements.cancelDraftButton.addEventListener("click", cancelDraft);
  elements.densifyButton.addEventListener("click", densifySelectedContour);
  elements.zoomOutButton.addEventListener("click", () => zoomImage(-1));
  elements.zoomInButton.addEventListener("click", () => zoomImage(1));
  elements.zoomFitButton.addEventListener("click", resetImageZoom);

  elements.softDragToggle.addEventListener("change", (event) => {
    state.softDrag = event.target.checked;
    scheduleDraftSave();
    setStatus(state.softDrag ? "Smooth edit enabled." : "Smooth edit disabled.");
  });

  elements.showPointsToggle.addEventListener("change", (event) => {
    state.showPoints = event.target.checked;
    renderAll();
    scheduleDraftSave();
    setStatus(
      state.showPoints
        ? "Point handles shown."
        : "Line edit mode: drag the contour line to reshape.",
    );
  });

  elements.softRadiusInput.addEventListener("input", (event) => {
    state.softRadius = finiteNumber(event.target.value, DEFAULT_SOFT_RADIUS);
    elements.softRadiusValue.textContent = `${state.softRadius} px`;
    scheduleDraftSave();
  });

  document.querySelectorAll(".mode-button").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });
  elements.shapeModeButtons.forEach((button) => {
    button.addEventListener("click", () => setDrawClosed(button.dataset.shape === "closed"));
  });

  elements.canvas.addEventListener("pointerdown", handlePointerDown);
  elements.canvas.addEventListener("pointermove", handlePointerMove);
  elements.canvas.addEventListener("pointerup", handlePointerUp);
  elements.canvas.addEventListener("pointercancel", (event) => {
    if (state.interaction?.type === "pan") {
      finishStagePan(event);
      return;
    }
    state.interaction = null;
    renderAll();
  });
  elements.stageShell.addEventListener("pointerdown", handleStagePointerDown);
  elements.stageShell.addEventListener("pointermove", handleStagePointerMove);
  elements.stageShell.addEventListener("pointerup", handleStagePointerUp);
  elements.stageShell.addEventListener("pointercancel", handleStagePointerUp);

  window.addEventListener("resize", fitCanvas);
  window.addEventListener("beforeunload", handleBeforeUnload);
  window.addEventListener("hashchange", () => {
    handleRouteChange().catch((error) => {
      console.error("Route change could not be completed.", error);
      setStatus("Navigation could not be completed.", true);
    });
  });
  window.addEventListener("keydown", (event) => {
    if (
      state.view !== "workspace" ||
      state.projectOperationBusy ||
      isInteractiveShortcutTarget(event.target)
    ) {
      return;
    }
    if (event.code === "Space") {
      state.spacePressed = true;
      if (state.image) {
        event.preventDefault();
      }
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteSelected();
    }
    if (event.key === "Enter" && state.mode === "draw") {
      event.preventDefault();
      finishDraftWithDefault();
    }
    if (event.key === "Escape" && state.mode === "draw") {
      event.preventDefault();
      cancelDraft();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    }
  });
  window.addEventListener("keyup", (event) => {
    if (event.code !== "Space") {
      return;
    }
    state.spacePressed = false;
    if (state.image && !isInteractiveShortcutTarget(event.target)) {
      event.preventDefault();
    }
  });

}

async function ensurePersistentStorage() {
  try {
    const { supported, persisted } = await storage.requestPersistentStorage();
    state.storagePersisted = supported ? persisted : false;
    renderProjectSaveState();
    const title = document.createElement("strong");
    title.textContent = persisted ? "Saved locally in this browser" : "Stored in this browser only";
    const detail = document.createTextNode(
      persisted
        ? " Clearing site data still removes local projects, so export annotation JSON for portable backups."
        : " The browser may clear local projects. Export annotation JSON for a portable backup.",
    );
    elements.hubStorageNote.replaceChildren(title, detail);
    if (supported && !persisted) {
      // Best-effort: annotating still works, the store is just evictable. Warn instead of
      // interrupting startup, so a later unexplained data loss has a trace to look at.
      console.warn("Persistent storage was denied; the browser may evict saved annotations.");
    }
  } catch (error) {
    state.storagePersisted = false;
    renderProjectSaveState();
    const title = document.createElement("strong");
    title.textContent = "Stored in this browser only";
    elements.hubStorageNote.replaceChildren(
      title,
      document.createTextNode(
        " Persistence could not be confirmed. Export annotation JSON for a portable backup.",
      ),
    );
    console.warn("Persistent storage could not be requested.", error);
  }
}

async function runLocalStorageMigrations() {
  const results = [];
  const resetDraft = new URLSearchParams(window.location.search).get("resetDraft") === "1";
  if (resetDraft) {
    await cleanupLegacyDraft();
    const url = new URL(window.location.href);
    url.searchParams.delete("resetDraft");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    results.push("Legacy single-image draft cleared; local projects were kept.");
  }
  const startedAt = performance.now();
  try {
    const result = await storage.migrateLegacyCurrentProject();
    if (result.migrated) {
      results.push("Recovered the previous image set as a local project.");
      console.info("Legacy local-project migration completed.", {
        imageCount: result.imageCount,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  } catch (error) {
    console.error("Legacy local-project migration failed; legacy data was kept.", error);
    results.push("Previous local work could not be migrated. Its stored data was kept; refresh to retry.");
  }
  if (!resetDraft) {
    try {
      const result = await migrateLegacySingleImageDraft();
      if (result.migrated) {
        results.push("Recovered a previous single-image draft as a local project.");
      }
    } catch (error) {
      console.error("Legacy single-image draft migration failed; draft data was kept.", error);
      results.push("A previous single-image draft could not be migrated and was kept for retry.");
    }
  }
  return results;
}

async function init() {
  setView("hub");
  configureSoftRadiusInput();
  renderLabels();
  renderAll();
  wireEvents();
  await ensurePersistentStorage();
  const migrationMessages = await runLocalStorageMigrations();
  await handleRouteChange();
  if (migrationMessages.length && state.view === "hub") {
    setStatus(migrationMessages.join(" "), migrationMessages.some((message) => /could not/i.test(message)));
  }
  drawCanvas();
}

init().catch((error) => {
  console.error(error);
  setStatus("App could not finish startup.", true);
  drawCanvas();
});
