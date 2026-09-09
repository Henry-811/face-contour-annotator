import {
  DEFAULT_SOFT_RADIUS,
  DRAFT_SAVE_DELAY_MS,
  DRAFT_STORAGE_KEY,
  HIT_RADIUS,
  IMAGE_ZOOM_STEP,
  LABEL_HIT_PADDING,
  LABELS,
  MAX_LEGACY_DRAFT_BYTES,
  MAX_ANNOTATION_FILE_BYTES,
  MAX_IMAGE_SET_ENTRIES,
  MAX_IMAGE_ZOOM,
  MIN_ANNOTATION_IMAGE_SIDE,
  MIN_CLOSED_POINTS,
  MIN_IMAGE_ZOOM,
  MIN_OPEN_POINTS,
  POINT_RADIUS,
  SOFT_RADIUS_MAX,
  SOFT_RADIUS_MIN,
  SOFT_RADIUS_STEP,
} from "./config.js?v=workspace-ux-2";
import * as geometry from "./geometry.js?v=workspace-ux-2";
import * as editing from "./contour-editing.js?v=workspace-ux-2";
import * as storage from "./storage.js?v=workspace-ux-2";
import {
  buildTaskSchema,
  getImageSize,
  normalizeImportedContours as normalizeImportedContourData,
  validateContoursForTaskSchema,
} from "./exporter.js?v=workspace-ux-2";
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
} from "./project.js?v=workspace-ux-2";
import {
  applyAnnotationImport,
  assertAnnotationImportHasMatches,
  buildAnnotationFile,
  normalizeAnnotationRelativePath,
  parseAnnotationFile,
  planAnnotationImport,
  stripSharedRootDirectory,
} from "./annotation-transfer.js?v=workspace-ux-2";
import { readImageSourcesFromZip } from "./zip-import.js?v=workspace-ux-2";
import { buildProjectHash, parseAppRoute } from "./routes.js?v=workspace-ux-2";
import {
  applyCanvasScale,
  drawAnnotationCanvas,
  getFitCanvasScale,
  getDisplayContourEntries,
  hitContourLabel,
} from "./renderer.js?v=workspace-ux-2";
import { buildDefaultFeatureContours } from "./templates.js?v=workspace-ux-2";
import {
  FOLDER_PROJECT_PREFIX, FOLDER_IMAGE_KIND, FOLDER_QUEUE_PAGE_SIZE, MAX_FOLDER_IMAGE_PIXELS,
  supportsFolderWorkspace, ensureFolderPermission, openFolderWorkspace,
  listFolderBookmarks, rememberFolderWorkspace, forgetFolderBookmark, validateFolderImage,
} from "./folder-workspace.js?v=workspace-ux-2";
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
  softDrag: false,
  showPoints: true,
  editTool: "points",
  selectedPoint: null,
  redraw: null,
  deletePreview: null,
  addPointArmed: false,
  addPointCandidate: null,
  saveError: "",
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
  folderWorkspace: null,
  pendingSourceHandle: null,
  folderBookmarks: [],
  queuePage: 0,
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
  newContourLabel: document.getElementById("newContourLabel"),
  selectedContourLabel: document.getElementById("selectedContourLabel"),
  selectionCaption: document.getElementById("selectionCaption"),
  pointActions: document.getElementById("pointActions"),
  addPointButton: document.getElementById("addPointButton"),
  deletePreviewActions: document.getElementById("deletePreviewActions"),
  applyDeleteButton: document.getElementById("applyDeleteButton"),
  cancelDeleteButton: document.getElementById("cancelDeleteButton"),
  saveErrorBanner: document.getElementById("saveErrorBanner"),
  saveErrorReason: document.getElementById("saveErrorReason"),
  retrySaveButton: document.getElementById("retrySaveButton"),
  backupAnnotationsButton: document.getElementById("backupAnnotationsButton"),
  fileMenu: document.getElementById("fileMenu"),
  contourInspector: document.getElementById("contourInspector"),
  inspectorToggle: document.getElementById("inspectorToggle"),
  closeInspector: document.getElementById("closeInspector"),
  currentImageStatus: document.getElementById("currentImageStatus"),
  softDragToggle: document.getElementById("softDragToggle"),
  showPointsToggle: document.getElementById("showPointsToggle"),
  softRadiusInput: document.getElementById("softRadiusInput"),
  softRadiusValue: document.getElementById("softRadiusValue"),
  editToolButtons: [...document.querySelectorAll("[data-edit-tool]")],
  editToolHint: document.getElementById("editToolHint"),
  deletePointButton: document.getElementById("deletePointButton"),
  redrawActions: document.getElementById("redrawActions"),
  applyRedrawButton: document.getElementById("applyRedrawButton"),
  cancelRedrawButton: document.getElementById("cancelRedrawButton"),
  alternateRedrawButton: document.getElementById("alternateRedrawButton"),
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
  openDirectoryButton: document.getElementById("openDirectoryButton"),
  chooseOutputButton: document.getElementById("chooseOutputButton"),
  directorySelection: document.getElementById("directorySelection"),
  folderSupportNote: document.getElementById("folderSupportNote"),
  saveNowButton: document.getElementById("saveNowButton"),
  folderOutputLocation: document.getElementById("folderOutputLocation"),
  queuePreviousPage: document.getElementById("queuePreviousPage"),
  queueNextPage: document.getElementById("queueNextPage"),
  queuePageLabel: document.getElementById("queuePageLabel"),
  queuePagination: document.getElementById("queuePagination"),
  annotationImportHelp: document.getElementById("annotationImportHelp"),
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
      directory: "Local folder · files on disk",
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
    openButton.addEventListener("click", () => project.source?.type === "directory"
      ? reconnectFolderProject(project) : navigateToProject(project.localProjectKey));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "delete-project-button";
    deleteButton.textContent = "Delete local copy";
    deleteButton.disabled = state.projectOperationBusy;
    deleteButton.setAttribute("aria-label", `Delete local copy of ${project.name || "untitled project"}`);
    deleteButton.addEventListener("click", () => deleteProjectFromHub(project));
    if (project.source?.type === "directory") {
      deleteButton.textContent = "Forget shortcut";
      deleteButton.setAttribute("aria-label", `Forget shortcut to ${project.name}; keep files on disk`);
    }
    actions.append(openButton, deleteButton);
    card.append(main, actions);
    elements.projectList.appendChild(card);
  });
}

async function refreshProjectLibrary() {
  state.hubLibraryStatus = "loading";
  renderProjectLibrary();
  state.hubProjects = await storage.listLocalProjects();
  try {
    state.folderBookmarks = await listFolderBookmarks();
  } catch (error) {
    console.warn("Recent folder shortcuts could not be read; output files are unaffected.", error);
    state.folderBookmarks = [];
  }
  state.hubProjects = [...state.folderBookmarks, ...state.hubProjects];
  state.hubLibraryStatus = "ready";
  renderProjectLibrary();
}

function setProjectOperationBusy(busy) {
  if (busy && state.interaction?.type === "pan") {
    finishStagePan(state.interaction);
  }
  if (busy && !state.projectOperationBusy && state.interaction?.previousSnapshot) {
    // A navigation/transfer may start before pointerup (e.g. browser Back).
    // Include the in-progress drag in the save barrier before disabling editing.
    commitChange(state.interaction.previousSnapshot);
    state.interaction = null;
  }
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
    editorVersion: 2,
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
  state.softDrag = preferences.editorVersion === 2 && preferences.softDrag === true;
  state.showPoints =
    preferences.editorVersion !== 2 || preferences.showPoints !== false;
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
  if (state.folderWorkspace) {
    imageRecord.draft = { points: state.draftPoints.map((point) => ({ ...point })), label: state.activeLabel, closed: state.drawClosed };
  }
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
      message = state.folderWorkspace ? "Folder save failed — retry or download current JSON" : "Local save failed — export annotations now";
      indicatorState = "failed";
    } else if (state.redraw || state.deletePreview) {
      message = "Preview — Apply to save";
      indicatorState = "saving";
    } else if (state.interaction && state.interaction.type !== "pan") {
      message = "Editing — release to save";
      indicatorState = "saving";
    } else if (
      state.projectSaveInFlight > 0 ||
      state.draftSaveTimer ||
      state.projectDirtyRevision > state.projectSavedRevision
    ) {
      message = state.folderWorkspace ? "Saving to output folder…" : "Saving locally…";
      indicatorState = "saving";
    } else {
      message = state.folderWorkspace ? "Saved to output folder" : "Saved locally";
      indicatorState = "saved";
    }
    if (!state.folderWorkspace && state.storagePersisted === false && indicatorState === "saved") {
      message += " · browser may clear it";
    }
  }
  elements.projectSaveState.textContent = message;
  elements.projectSaveState.dataset.state = indicatorState;
  elements.saveErrorBanner.hidden = indicatorState !== "failed";
  elements.saveErrorReason.textContent = state.saveError || message;
  if (elements.saveNowButton) elements.saveNowButton.textContent = indicatorState === "failed" ? "Retry save" : "Save now";
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
  if (state.folderWorkspace) {
    return {
      generation: state.projectGeneration, revision: state.projectDirtyRevision,
      folderWorkspace: state.folderWorkspace,
      image: structuredClone(getCurrentProjectImageRecord()),
      preferences: buildProjectPreferences(),
    };
  }
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
    if (snapshot.folderWorkspace) {
      await snapshot.folderWorkspace.saveImage({ image: snapshot.image, preferences: snapshot.preferences });
    } else {
      await storage.putLocalProjectSnapshot({ project: snapshot.project, image: snapshot.image });
    }
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
        state.saveError = error.message || "Save failed. Download a backup before closing this page.";
        setProjectSaveStatus("failed");
        console.error("Image-set snapshot could not be saved.", error);
        setStatus(
          state.folderWorkspace ? (error.message || "Folder save failed. Download current JSON to keep the latest work.") : "Local save failed. Export annotations now to keep the latest work.",
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
  if (!confirmDiscardRedraw()) {
    const error = new Error("Apply or cancel the redraw before leaving this image.");
    error.code = "REDRAW_PENDING";
    throw error;
  }
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
  state.saveError = "";
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
  state.folderWorkspace?.close();
  state.folderWorkspace = null;
  if (state.imageDataUrl.startsWith("blob:")) URL.revokeObjectURL(state.imageDataUrl);
  state.queuePage = 0;
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
  state.softDrag = false;
  state.showPoints = true;
  state.editTool = "points";
  state.selectedPoint = null;
  state.redraw = null;
  state.deletePreview = null;
  resetPointInsertion();
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
  // Keep the latest edits in the current record even while persistence is blocked.
  syncCurrentProjectImage();
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
  resetPointInsertion();
  state.selectedPoint = null;
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
  if (state.projectOperationBusy || state.interaction || !confirmDiscardRedraw()) return;
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
  if (state.projectOperationBusy || state.interaction || !confirmDiscardRedraw()) return;
  if (!state.redoStack.length) {
    return;
  }
  const current = snapshotContours();
  const next = state.redoStack.pop();
  state.undoStack.push(current);
  restoreContours(next);
  setStatus("Redone.");
}

function normalizePoint(point) {
  return geometry.normalizePointToImage(point, getCurrentImageSize());
}

function toCanvasPoint(event) {
  const rect = elements.canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(state.image.naturalWidth, (event.clientX - rect.left) / state.scale)),
    y: Math.max(0, Math.min(state.image.naturalHeight, (event.clientY - rect.top) / state.scale)),
  };
}

function distance(a, b) {
  return geometry.distance(a, b);
}

function hitTest(point) {
  return editing.hitContours({
    contours: state.contours,
    point,
    selectedId: state.selectedId,
    vertices: state.editTool === "points" && state.showPoints,
    tolerance: HIT_RADIUS / state.scale,
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
    }).filter((entry) => entry.isSelected),
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
    button.setAttribute("aria-pressed", String(button.dataset.mode === state.mode));
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
  if (state.projectOperationBusy) return;
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
  if (state.projectOperationBusy || state.interaction || !confirmDiscardRedraw()) return;
  if (mode === "edit") {
    mode = "refine";
  }
  if (mode !== "draw" && mode !== "refine") {
    return;
  }
  resetPointInsertion();
  state.mode = mode;
  updateCommandState();
  scheduleDraftSave();
  setStatus(
    mode === "draw"
      ? "Draw mode."
      : "Edit points: drag an existing point; double-click the line to add a point.",
  );
  drawCanvas();
}

function selectContour(id) {
  if (state.projectOperationBusy || state.interaction) return;
  if (!confirmDiscardRedraw()) return;
  resetPointInsertion();
  state.selectedPoint = null;
  state.selectedId = id;
  if (!state.draftPoints.length) state.mode = "refine";
  scheduleDraftSave();
  renderAll();
}

function deleteSelected() {
  if (state.projectOperationBusy || state.interaction || !confirmDiscardRedraw()) return;
  if (!state.selectedId) {
    setStatus("No contour selected.", true);
    return;
  }
  const previous = snapshotContours();
  state.contours = state.contours.filter((contour) => contour.id !== state.selectedId);
  state.selectedPoint = null;
  resetPointInsertion();
  state.selectedId = state.contours[0]?.id || null;
  commitChange(previous);
  renderAll();
  setStatus("Selected contour deleted.");
}

function clearContours() {
  if (state.projectOperationBusy || state.interaction || !confirmDiscardRedraw()) return;
  if (!state.contours.length) {
    return;
  }
  if (!window.confirm("Clear all contours on this image? You can undo this action.")) return;
  const previous = snapshotContours();
  state.contours = [];
  state.selectedId = null;
  state.selectedPoint = null;
  resetPointInsertion();
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
    points,
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
  if (state.folderWorkspace) scheduleProjectSave();
  renderAll();
  setStatus("Draft contour canceled.");
}

function deleteSelectedPoint() {
  if (state.projectOperationBusy || state.interaction || state.redraw || state.deletePreview || state.mode !== "refine" || state.editTool !== "points") return;
  const contour = state.contours.find((candidate) => candidate.id === state.selectedId);
  if (!contour || state.selectedPoint?.contourId !== contour.id) return;
  const result = editing.planPointDeletion({ contour, pointIndex: state.selectedPoint.index });
  if (!result) { setStatus(`Keep at least ${contour.closed ? 3 : 2} points on this contour.`, true); return; }
  const errors = validateContoursForTaskSchema({ contours: [result.contour], labels: LABELS, imageSize: getCurrentImageSize() });
  if (errors.length) { setStatus(`Cannot remove this point: ${errors[0]}`, true); return; }
  resetPointInsertion();
  if (!result.exact) {
    state.deletePreview = result.contour;
    renderAll();
    setStatus("Delete preview: green shows the fitted curve. Apply deletion or Cancel; nothing has been changed yet.");
    return;
  }
  const previous = snapshotContours();
  replaceContour(result.contour);
  state.selectedPoint = null;
  commitChange(previous);
  renderAll();
  setStatus("Point deleted; the original curve was restored.");
}

function applyPointDeletion() {
  if (state.projectOperationBusy || !state.deletePreview) return;
  const previous = snapshotContours();
  replaceContour(state.deletePreview);
  state.deletePreview = null;
  state.selectedPoint = null;
  commitChange(previous);
  renderAll();
  setStatus("Point deleted. Undo restores the previous curve.");
}

function cancelPointDeletion() {
  state.deletePreview = null;
  renderAll();
  setStatus("Deletion canceled. The contour is unchanged.");
}

function resetPointInsertion() {
  state.addPointArmed = false;
  state.addPointCandidate = null;
}

function insertPointAt(point) {
  if (state.projectOperationBusy || state.interaction || state.redraw || state.deletePreview || state.mode !== "refine" || state.editTool !== "points") return;
  const contour = state.contours.find((candidate) => candidate.id === state.selectedId);
  if (!contour) return;
  const hit = editing.hitContours({ contours: [contour], selectedId: contour.id, point, tolerance: HIT_RADIUS / state.scale });
  if (hit?.type !== "edge") return;
  try {
    const result = editing.insertCurvePoint({ contour, segmentIndex: hit.segmentIndex, segmentT: hit.segmentT, imageSize: getCurrentImageSize() });
    if (result.contour.points.length === contour.points.length) return;
    const errors = validateContoursForTaskSchema({ contours: [result.contour], labels: LABELS, imageSize: getCurrentImageSize() });
    if (errors.length) throw new Error(errors[0]);
    const previous = snapshotContours();
    replaceContour(result.contour);
    state.selectedPoint = { contourId: contour.id, index: result.pointIndex };
    resetPointInsertion();
    commitChange(previous);
    renderAll();
    setStatus("Point added without changing the curve.");
  } catch (error) {
    setStatus(error.message || "Could not add a point here.", true);
  }
}

function initializeFeatureTemplate() {
  if (state.projectOperationBusy || state.interaction || !confirmDiscardRedraw()) return;
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
  state.mode = "refine";
  state.editTool = "points";
  state.selectedPoint = null;
  resetPointInsertion();
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
    if (state.folderWorkspace) {
      syncCurrentProjectImage();
      elements.jsonOutput.value = JSON.stringify(state.folderWorkspace.buildImageFile(getCurrentProjectImageRecord()), null, 2);
      return;
    }
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
  const busy = state.projectOperationBusy || Boolean(state.redraw || state.deletePreview) || Boolean(state.interaction && state.interaction.type !== "pan");
  elements.newContourLabel.disabled = busy;
  elements.selectedContourLabel.disabled = busy || !state.selectedId;
  elements.contourList.querySelectorAll("button, select").forEach((control) => { control.disabled = busy; });
  elements.contourList.inert = busy;
  elements.undoButton.disabled = busy || state.undoStack.length === 0;
  elements.redoButton.disabled = busy || state.redoStack.length === 0;
  elements.deleteButton.disabled = busy || !state.selectedId;
  elements.initializeTemplateButton.disabled = busy || !canInitializeFeatureTemplate();
  elements.clearButton.disabled = busy || state.contours.length === 0;
  elements.openImageButton.disabled = busy;
  elements.openFolderButton.disabled = busy;
  elements.openZipButton.disabled = busy;
  elements.openDirectoryButton.disabled = busy || !supportsFolderWorkspace();
  elements.chooseOutputButton.disabled = busy || !state.pendingSourceHandle;
  elements.saveNowButton.hidden = !state.project;
  elements.saveNowButton.disabled = busy || !state.image;
  elements.retrySaveButton.disabled = busy || !state.image;
  elements.backupAnnotationsButton.disabled = busy || !state.project;
  elements.folderOutputLocation.hidden = !state.folderWorkspace;
  elements.folderOutputLocation.textContent = state.folderWorkspace ? `Output: ${state.folderWorkspace.outputHandle.name} / annotations` : "";
  elements.exportAnnotationsButton.textContent = state.folderWorkspace ? "Download current JSON" : "Export JSON";
  elements.importAnnotationsButton.textContent = state.folderWorkspace ? "Restore current JSON" : "Import JSON";
  elements.annotationImportHelp.textContent = state.folderWorkspace
    ? "Each image is saved automatically under the output folder's annotations directory. Back up that folder. These buttons download or restore the current image only."
    : "One JSON contains this project's relative paths, progress, and contours. Imports match by path and image size.";
  elements.projectList.querySelectorAll("button").forEach((button) => {
    button.disabled = busy;
  });
  elements.exitProjectButton.disabled = state.projectOperationBusy || !state.project;
  elements.exportAnnotationsButton.disabled = !state.project || busy;
  elements.importAnnotationsButton.disabled = !state.image || busy;
  elements.finishDraftButton.disabled =
    busy ||
    state.draftPoints.length < getMinimumPoints(state.drawClosed) ||
    !isShapeAllowed(state.activeLabel, state.drawClosed);
  elements.finishDraftButton.textContent = state.drawClosed ? "Finish Region" : "Finish Line";
  elements.cancelDraftButton.disabled = busy || state.draftPoints.length === 0;
  elements.editToolButtons.forEach((button) => {
    button.disabled = busy || !state.image;
    const active = state.mode === "refine" && button.dataset.editTool === state.editTool;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  elements.addPointButton.disabled = busy || !state.selectedId;
  elements.addPointButton.setAttribute("aria-pressed", String(state.addPointArmed));
  elements.addPointButton.textContent = state.addPointArmed ? "Cancel add point" : "+ Add point";
  elements.pointActions.hidden = state.editTool !== "points" || Boolean(state.deletePreview);
  elements.deletePreviewActions.hidden = !state.deletePreview;
  elements.applyDeleteButton.disabled = state.projectOperationBusy;
  elements.cancelDeleteButton.disabled = state.projectOperationBusy;
  elements.deletePointButton.disabled = busy || state.editTool !== "points" || state.selectedPoint?.contourId !== state.selectedId;
  elements.redrawActions.hidden = !state.redraw;
  elements.applyRedrawButton.disabled = state.projectOperationBusy || !state.redraw?.preview;
  elements.cancelRedrawButton.disabled = state.projectOperationBusy;
  elements.alternateRedrawButton.hidden = !state.redraw?.preview || !state.contours.find((c) => c.id === state.selectedId)?.closed;
  elements.alternateRedrawButton.disabled = state.projectOperationBusy;
  elements.editToolHint.textContent = state.editTool === "points"
    ? state.deletePreview ? "Green = fitted curve. Apply or Cancel."
      : state.addPointArmed ? "Click the selected line to add one point · Esc cancels"
        : "Double-click line to add · Drag point to move"
    : state.editTool === "transform"
      ? "Drag to move. Square handles resize; Shift keeps proportions. The round handle rotates."
      : state.redraw?.preview ? "Dashed red = removed arc. Green = replacement. Apply to save, or choose the other arc."
        : state.redraw ? "Click the replacement path, then click the same contour to finish. Esc cancels."
          : "Select a contour, then click its line to start redrawing a section.";
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
  for (const select of [elements.newContourLabel, elements.selectedContourLabel]) {
    if (select.options.length) continue;
    LABELS.forEach((label) => {
      const option = document.createElement("option");
      option.value = label.id;
      const swatch = document.createElement("span");
      swatch.className = "label-swatch";
      swatch.style.backgroundColor = label.color;
      swatch.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "label-name";
      name.textContent = label.name;
      option.append(swatch, name);
      select.appendChild(option);
    });
  }
  elements.newContourLabel.value = state.activeLabel;
}

function renderContourList() {
  elements.contourCount.textContent = String(state.contours.length);
  const focusedId = elements.contourList.contains(document.activeElement) ? document.activeElement.dataset.contourId : null;
  elements.contourList.replaceChildren();
  if (!state.contours.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "No contours. Initialize or draw a new contour.";
    elements.contourList.appendChild(empty);
  }
  state.contours.forEach((contour) => {
    const label = getLabel(contour.label);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "contour-item";
    item.dataset.contourId = contour.id;
    item.classList.toggle("is-selected", contour.id === state.selectedId);
    item.setAttribute("aria-pressed", String(contour.id === state.selectedId));
    item.setAttribute("aria-label", `${label.name}, ${contour.points.length} points`);
    item.title = `${contour.closed ? "Closed curve" : "Open curve"} · ${contour.points.length} points`;
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = label.color;
    const name = document.createElement("span");
    name.textContent = label.name;
    const count = document.createElement("span");
    count.className = "point-count";
    count.textContent = String(contour.points.length);
    item.append(swatch, name, count);
    item.addEventListener("click", () => selectContour(contour.id));
    elements.contourList.appendChild(item);
    if (contour.id === focusedId) item.focus({ preventScroll: true });
  });
  const selected = state.contours.find((contour) => contour.id === state.selectedId);
  elements.selectedContourLabel.hidden = !selected;
  elements.selectionCaption.textContent = selected ? "Editing" : "Select a contour";
  if (selected) {
    elements.selectedContourLabel.value = selected.label;
    elements.deleteButton.title = `Delete selected contour: ${getLabel(selected.label).name}. Undo is available.`;
  } else {
    elements.deleteButton.title = "Select a contour to delete it.";
  }
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
  elements.projectName.title = project?.name || "";
  const currentStatus = getCurrentProjectImageRecord()?.status || "unlabeled";
  elements.currentImageStatus.textContent = getStatusLabel(currentStatus);
  elements.currentImageStatus.dataset.status = currentStatus;
  elements.projectProgress.textContent = `${progress.done} done, ${progress.in_progress} active`;
  renderProjectSaveState();
  elements.previousImageButton.disabled =
    state.projectOperationBusy || !getAdjacentImageId(project, -1);
  elements.nextImageButton.disabled =
    state.projectOperationBusy || !getAdjacentImageId(project, 1);
  const hasImage = Boolean(state.image);
  const statusLocked = state.projectOperationBusy || Boolean(state.redraw || state.deletePreview) || Boolean(state.interaction) || !hasImage;
  elements.markDoneButton.disabled = statusLocked;
  elements.skipImageButton.disabled = statusLocked;
  elements.needsReviewButton.disabled = statusLocked;
  elements.imageQueueList.innerHTML = "";
  if (!images.length) {
    elements.queuePagination.hidden = true;
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "No images";
    elements.imageQueueList.appendChild(empty);
    return;
  }
  const paginated = Boolean(state.folderWorkspace) && images.length > FOLDER_QUEUE_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(images.length / FOLDER_QUEUE_PAGE_SIZE));
  state.queuePage = Math.min(state.queuePage, pageCount - 1);
  elements.queuePagination.hidden = !paginated;
  elements.queuePageLabel.textContent = `${state.queuePage + 1} / ${pageCount}`;
  elements.queuePreviousPage.disabled = state.projectOperationBusy || state.queuePage === 0;
  elements.queueNextPage.disabled = state.projectOperationBusy || state.queuePage + 1 >= pageCount;
  const visibleImages = paginated ? images.slice(state.queuePage * FOLDER_QUEUE_PAGE_SIZE, (state.queuePage + 1) * FOLDER_QUEUE_PAGE_SIZE) : images;
  visibleImages.forEach((image) => {
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
      const returnToQueue = elements.imageQueueDisclosure.open;
      switchToProjectImage(image.id).then(() => {
        if (state.currentImageId === image.id) {
          closeWorkspaceMenu(elements.imageQueueDisclosure);
          if (returnToQueue) elements.imageQueueDisclosure.querySelector("summary").focus({ preventScroll: true });
        }
      }).catch((error) => { console.error("Image navigation failed.", error); setStatus(error.message, true); });
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
    showPoints: state.showPoints && state.mode === "refine" && state.editTool === "points",
    pointRadius: POINT_RADIUS,
    editor: state.mode === "refine" ? {
      tool: state.editTool,
      selectedPointIndex: state.selectedPoint?.contourId === state.selectedId ? state.selectedPoint.index : null,
      redraw: state.redraw, hoverPoint: state.hoverPoint,
      deletePreview: state.deletePreview,
      addPointCandidate: state.addPointCandidate,
      softPoint: state.editTool === "points" && state.softDrag ? state.hoverPoint : null,
      softRadius: state.softRadius / state.scale,
    } : {},
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
  elements.fileMeta.title = elements.fileMeta.textContent;
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
  if (typeof dataUrl !== "string" || !(dataUrl.startsWith("data:image/") || (options.folderImage && dataUrl.startsWith("blob:")))) {
    setStatus("Saved image data is not valid.", true);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      if (options.folderImage && image.naturalWidth * image.naturalHeight > MAX_FOLDER_IMAGE_PIXELS) {
        setStatus("This image exceeds the 64-megapixel limit.", true);
        resolve(false);
        return;
      }
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
          ? options.folderImage ? geometry.cloneContours(options.contours) : normalizeContoursForImage(options.contours, getImageSize(image))
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
          options.beforeCommit(image);
        } catch (error) {
          console.error("Image selection could not be committed.", error);
          setStatus("Image selection could not be committed.", true);
          resolve(false);
          return;
        }
      }
      if (state.imageDataUrl.startsWith("blob:") && state.imageDataUrl !== dataUrl) URL.revokeObjectURL(state.imageDataUrl);
      state.image = image;
      state.imageDataUrl = dataUrl;
      state.imagePersisted = Boolean(options.imageStored);
      state.fileName = fileName || "image";
      state.contours = nextContours;
      state.redraw = null;
      state.deletePreview = null;
      resetPointInsertion();
      state.selectedPoint = null;
      state.editTool = "points";
      state.selectedId = state.contours.some((contour) => contour.id === options.selectedId)
        ? options.selectedId
        : state.contours[0]?.id || null;
      state.draftPoints = options.draft?.points?.map((point) => ({ ...point })) || [];
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
      state.softDrag = typeof options.softDrag === "boolean" ? options.softDrag : false;
      state.showPoints = typeof options.showPoints === "boolean" ? options.showPoints : true;
      state.softRadius = finiteNumber(options.softRadius, state.softRadius);
      state.imageZoom =
        typeof options.imageZoom === "number" ? clampImageZoom(options.imageZoom) : 1;
      if (templateInitialized && typeof options.mode !== "string") {
        state.mode = "refine";
      }
      if (state.draftPoints.length) {
        state.activeLabel = options.draft.label;
        state.drawClosed = options.draft.closed;
        state.mode = "draw";
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
  if (state.folderWorkspace) {
    const loaded = await state.folderWorkspace.loadImage(imageRecord);
    const url = URL.createObjectURL(loaded.file);
    const record = loaded.record;
    const previous = getCurrentProjectImageRecord();
    const displayed = await loadImageDataUrl(url, imageRecord.path, {
      ...buildProjectPreferences(), folderImage: true, persist: false,
      contours: record?.contours, selectedId: record?.selectedId, draft: record?.draft,
      autoInitializeTemplate: !record, expectedImageRecord: record,
      beforeCommit(image) {
        loaded.commit();
        if (previous && previous.id !== imageRecord.id) { delete previous.contours; delete previous.draft; }
        Object.assign(imageRecord, { width: image.naturalWidth, height: image.naturalHeight, status: record?.status || "unlabeled" });
        state.currentImageId = imageRecord.id;
        state.project.currentImageId = imageRecord.id;
        state.queuePage = Math.floor(getImageIndex(state.project, imageRecord.id) / FOLDER_QUEUE_PAGE_SIZE);
      },
      status: `Loaded ${imageRecord.path}. Annotations save to ${state.folderWorkspace.outputHandle.name}.`,
    });
    if (!displayed) URL.revokeObjectURL(url);
    else syncCurrentProjectImage();
    return displayed;
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

async function rememberFolderShortcut(workspace) {
  try {
    await rememberFolderWorkspace(workspace);
  } catch (error) {
    console.warn("Folder shortcut could not be saved; annotation files are unaffected.", error);
    setStatus("Files are saved, but the recent shortcut could not be remembered. Select both folders again next time.", true);
  }
}

async function activateFolderWorkspace({ sourceHandle, outputHandle, routeEpoch = state.routeEpoch }) {
  if (state.projectOperationBusy) return false;
  const routeRequest = { ...captureRouteRequest(), routeEpoch };
  setProjectOperationBusy(true);
  let workspace;
  try {
    setStatus("Opening folders and checking saved annotations…");
    workspace = await openFolderWorkspace({ sourceHandle, outputHandle, onProgress: setStatus });
    if (!isRouteRequestCurrent(routeRequest)) {
      workspace.close();
      state.routeRetryPending = true;
      return false;
    }
    clearWorkspaceState();
    state.folderWorkspace = workspace;
    state.project = workspace.project;
    state.currentImageId = workspace.project.currentImageId;
    applyProjectPreferences(workspace.project.preferences);
    resetProjectSaveTracking();
    setView("workspace");
    if (!await loadProjectImageRecord(getCurrentImage(state.project))) throw new Error("The selected image could not be decoded. Its existing annotations were not changed.");
    if (isRouteRequestCurrent(routeRequest)) {
      window.history.replaceState(null, "", buildProjectHash(state.project.localProjectKey));
    } else {
      // Image hashing/decoding can outlast a newer Back or hash navigation.
      // Preserve that destination and process it through the normal save barrier.
      state.routeRetryPending = true;
    }
    await rememberFolderShortcut(workspace);
    scheduleProjectSave();
    elements.workspaceTitle.focus({ preventScroll: true });
    return true;
  } catch (error) {
    workspace?.close();
    if (state.folderWorkspace === workspace) clearWorkspaceState();
    if (!isRouteRequestCurrent(routeRequest)) {
      state.routeRetryPending = true;
      console.warn("Superseded folder opening failed.", error);
      return false;
    }
    window.history.replaceState(null, "", getBareLocation());
    console.error("Folder workspace could not be opened.", error);
    await showProjectHub({ message: error.message || "Folder workspace could not be opened.", isError: true });
    return false;
  } finally {
    setProjectOperationBusy(false);
    renderAll();
  }
}

async function chooseImageDirectory() {
  if (state.projectOperationBusy || state.view !== "hub") return;
  try {
    const handle = await window.showDirectoryPicker({ id: "face-contour-images", mode: "read" });
    state.pendingSourceHandle = handle;
    elements.directorySelection.textContent = `Images: ${handle.name} (read-only)`;
    elements.chooseOutputButton.hidden = false;
    updateCommandState();
    elements.chooseOutputButton.focus();
    setStatus("Now choose a separate output folder for annotation JSON. Existing output files will be reopened, not reset.");
  } catch (error) {
    if (error.name === "AbortError") { setStatus("Folder selection cancelled."); return; }
    console.error("Image folder selection failed.", error);
    setStatus("Cannot open folders. Use desktop Chrome or Edge on HTTPS or localhost, and allow folder access.", true);
  }
}

async function chooseOutputDirectory() {
  if (state.projectOperationBusy || !state.pendingSourceHandle) return;
  try {
    const outputHandle = await window.showDirectoryPicker({ id: "face-contour-output", mode: "readwrite" });
    await activateFolderWorkspace({ sourceHandle: state.pendingSourceHandle, outputHandle });
  } catch (error) {
    if (error.name === "AbortError") { setStatus("Output folder selection cancelled. Your image folder selection was kept."); return; }
    console.error("Output folder selection failed.", error);
    setStatus(error.message || "Allow write access to the output folder and try again.", true);
  }
}

async function reconnectFolderProject(bookmark) {
  if (state.projectOperationBusy) return;
  try {
    await ensureFolderPermission({ handle: bookmark.sourceHandle, mode: "read", request: true });
    await ensureFolderPermission({ handle: bookmark.outputHandle, mode: "readwrite", request: true });
    await activateFolderWorkspace(bookmark);
  } catch (error) {
    console.warn("Folder reconnect failed.", error);
    setStatus(error.message || "Choose both folders again to reconnect.", true);
  }
}

async function retryCurrentSave() {
  if (!state.project || state.projectOperationBusy) return;
  if (!confirmDiscardRedraw()) return;
  setProjectOperationBusy(true);
  try {
    if (state.folderWorkspace) {
      await ensureFolderPermission({ handle: state.folderWorkspace.sourceHandle, mode: "read", request: true });
      await ensureFolderPermission({ handle: state.folderWorkspace.outputHandle, mode: "readwrite", request: true });
    }
    await state.projectWriteTail;
    state.draftSaveBlocked = false;
    markProjectDirty();
    await flushProjectSaves();
    setStatus(state.folderWorkspace ? "Latest changes saved to the output folder." : "Latest changes saved locally.");
  } catch (error) {
    state.draftSaveBlocked = true;
    state.saveError = error.message || "Save failed. Download a backup before closing this page.";
    setProjectSaveStatus("failed");
    console.error("Save retry failed.", error);
    setStatus(error.message || "Save failed. Download current JSON before leaving.", true);
  } finally {
    setProjectOperationBusy(false);
    renderAll();
  }
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
  setProjectOperationBusy(true);
  try {
    await flushProjectSaves();
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
  } finally {
    setProjectOperationBusy(false);
    renderProjectPanel();
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
  if (state.projectOperationBusy || state.interaction) {
    return;
  }
  if (state.redraw || state.deletePreview) { setStatus("Apply or cancel the preview before changing this image's status.", true); return; }
  syncCurrentProjectImage();
  const imageRecord = getCurrentProjectImageRecord();
  if (!imageRecord) {
    setStatus("Open an image before changing status.", true);
    return;
  }
  if (status === "done") {
    if (state.draftPoints.length) {
      setStatus("Finish or cancel the unfinished drawing before marking this image Done.", true);
      return;
    }
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
  if (localProjectKey.startsWith(FOLDER_PROJECT_PREFIX)) {
    try {
      const bookmarks = await listFolderBookmarks();
      const bookmark = bookmarks.find((item) => item.localProjectKey === localProjectKey);
      if (!bookmark) throw new Error("Choose the original image and output folders to reopen this workspace. Files on disk were not deleted.");
      return await activateFolderWorkspace({ ...bookmark, routeEpoch });
    } catch (error) {
      console.warn("Folder workspace needs reconnecting.", error);
      if (routeEpoch === state.routeEpoch) {
        window.history.replaceState(null, "", getBareLocation());
        await showProjectHub({ message: error.message, isError: true });
      }
      return false;
    }
  }
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
      if (error.code === "REDRAW_PENDING") { setStatus(error.message, true); return false; }
      // A failed earlier snapshot may have later writes already queued. Keep
      // the workspace lease until those writes (and their cleanup) settle.
      await state.projectWriteTail;
      const confirmed = window.confirm(
        state.folderWorkspace
          ? "The latest changes are not saved to the output folder. Download current JSON first if you need them. Exit anyway and abandon those unsaved changes?"
          : "The latest changes are not saved in this browser. Export annotation JSON first if you need them. Exit anyway and abandon those unsaved changes?",
      );
      if (!confirmed) {
        setStatus("Exit cancelled. Export annotations or retry after local saving recovers.", true);
        return false;
      }
      abandonedUnsavedChanges = true;
    }
    if (state.folderWorkspace) await rememberFolderShortcut(state.folderWorkspace);
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
  const directoryProject = project.source?.type === "directory";
  const confirmed = window.confirm(
    directoryProject
      ? `Forget the shortcut to “${name}”? All original images and output annotation files will stay on disk.`
      : `Delete the local copy of “${name}”? This removes its images and annotations from this browser only. Original files and exported JSON are not affected.`,
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
    const deleted = directoryProject
      ? (await forgetFolderBookmark(project.localProjectKey), true)
      : await storage.deleteLocalProject(project.localProjectKey);
    state.hubProjects = state.hubProjects.filter(
      (candidate) => candidate.localProjectKey !== project.localProjectKey,
    );
    state.hubLibraryStatus = "ready";
    renderProjectLibrary();
    restoreFocus = true;
    try {
      await refreshProjectLibrary();
      setStatus(
        directoryProject ? `Forgot shortcut to ${name}. Files on disk were kept.` : deleted ? `Deleted the local copy of ${name}.` : `${name} was already removed.`,
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

function startStagePan(event, captureTarget) {
  if (!state.image || state.interaction || !isStageScrollable()) {
    return false;
  }
  event.preventDefault();
  captureTarget.setPointerCapture?.(event.pointerId);
  state.interaction = {
    type: "pan",
    pointerId: event.pointerId,
    // PointerEvent.buttons uses left=1, right=2, middle=4 bit flags.
    buttonMask: event.button === 1 ? 4 : event.button === 2 ? 2 : 1,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startScrollLeft: elements.stageShell.scrollLeft,
    startScrollTop: elements.stageShell.scrollTop,
  };
  elements.stageShell.classList.add("is-panning");
  return true;
}

function updateStagePan(event, interaction) {
  if (event.pointerId !== interaction.pointerId) {
    return;
  }
  if (!(event.buttons & interaction.buttonMask)) {
    finishStagePan(event);
    return;
  }
  const dx = event.clientX - interaction.startClientX;
  const dy = event.clientY - interaction.startClientY;
  elements.stageShell.scrollLeft = interaction.startScrollLeft - dx;
  elements.stageShell.scrollTop = interaction.startScrollTop - dy;
}

function finishStagePan(event) {
  if (state.interaction?.type !== "pan" || event.pointerId !== state.interaction.pointerId) {
    return;
  }
  state.interaction = null;
  if (elements.canvas.hasPointerCapture?.(event.pointerId)) {
    elements.canvas.releasePointerCapture(event.pointerId);
  }
  if (elements.stageShell.hasPointerCapture?.(event.pointerId)) {
    elements.stageShell.releasePointerCapture(event.pointerId);
  }
  elements.stageShell.classList.remove("is-panning");
  updateStagePanState();
}

function shouldPanCanvas(event) {
  return event.button === 2 || event.button === 1 || (event.button === 0 && state.spacePressed);
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
  if (state.folderWorkspace) {
    markCurrentImageStatus("in_progress");
    scheduleProjectSave();
  }
  renderAll();
  setStatus("Point added.");
}

function replaceContour(contour) {
  state.contours = state.contours.map((c) => c.id === contour.id ? contour : c);
}

function confirmDiscardRedraw() {
  if (state.deletePreview) {
    if (!window.confirm("Discard this unapplied point deletion? Saved contours will stay unchanged.")) return false;
    cancelPointDeletion();
  }
  if (!state.redraw) return true;
  if (!window.confirm("Discard this unapplied redraw? Saved contours will stay unchanged.")) return false;
  cancelRedraw();
  return true;
}

function cancelRedraw() {
  state.redraw = null;
  state.hoverPoint = null;
  renderAll();
  setStatus("Redraw cancelled. The saved contour was not changed.");
}

function updateRedrawPreview() {
  const draft = state.redraw;
  const contour = state.contours.find((c) => c.id === draft.contourId);
  try {
    draft.preview = editing.redrawContour({ contour, ...draft });
    const errors = validateContoursForTaskSchema({ contours: [draft.preview.contour], labels: LABELS, imageSize: getCurrentImageSize() });
    if (errors.length) throw new Error(errors[0]);
  } catch (error) {
    draft.end = null;
    draft.preview = null;
    setStatus(error.message, true);
  }
  renderAll();
}

function applyRedraw() {
  if (state.projectOperationBusy || !state.redraw?.preview) return;
  const previous = snapshotContours();
  replaceContour(state.redraw.preview.contour);
  state.redraw = null;
  state.selectedPoint = null;
  commitChange(previous);
  renderAll();
  setStatus("Section replaced and queued for saving. Undo restores the original curve.");
}

function handleRedrawPoint(point) {
  const contour = state.contours.find((c) => c.id === state.selectedId);
  if (!contour) { setStatus("Select a contour first.", true); return; }
  const hit = editing.nearestCurvePoint({ contour, point });
  if (!state.redraw) {
    if (!hit || hit.distance > HIT_RADIUS / state.scale) {
      const other = hitTest(point);
      if (other) selectContour(other.contour.id);
      setStatus("Click the selected contour line to start."); return;
    }
    const segment = editing.curveSegments(contour)[hit.segmentIndex];
    const startPoint = editing.splitSegment({ segment, t: hit.segmentT })[0].end;
    if (!editing.isPointInsideImage({ point: startPoint, imageSize: getCurrentImageSize() })) {
      setStatus("Start on a visible part of the curve inside the image.", true); return;
    }
    state.redraw = { contourId: contour.id, start: hit, startPoint, points: [], end: null, alternate: false, preview: null };
    // Store only positional anchors, not hit-test contour references.
    state.redraw.start = { segmentIndex: hit.segmentIndex, segmentT: hit.segmentT };
  } else if (!state.redraw.preview) {
    if (hit && hit.distance <= HIT_RADIUS / state.scale) {
      state.redraw.end = { segmentIndex: hit.segmentIndex, segmentT: hit.segmentT };
      updateRedrawPreview();
    } else {
      state.redraw.points.push(point);
    }
  }
  renderAll();
}

function handleRefinePointerDown(point, event) {
  if (state.deletePreview) return;
  if (state.addPointArmed) { insertPointAt(point); return; }
  if (state.editTool === "redraw") { handleRedrawPoint(point); return; }
  const selected = state.contours.find((c) => c.id === state.selectedId);
  const handle = state.editTool === "transform" && selected
    ? editing.hitTransformHandle({ contour: selected, scale: state.scale, imageSize: getCurrentImageSize(), point }) : null;
  const curveHit = hitTest(point);
  const hit = handle ? { contour: selected, type: "transform" }
    : curveHit?.type === "vertex" ? curveHit : hitLabel(point) || curveHit;
  if (!hit) {
    state.selectedPoint = null;
    state.selectedId = null;
    startStagePan(event, elements.canvas);
    renderAll(); return;
  }
  const previousSnapshot = snapshotContours();
  state.selectedId = hit.contour.id;
  state.selectedPoint = null;
  const original = editing.materializeContour(hit.contour);
  const interaction = { type: "move", contourId: hit.contour.id, previousSnapshot, original, startPoint: point, pointerId: event.pointerId };
  if (handle) {
    interaction.type = "transform";
    interaction.handle = handle;
  } else if (state.editTool === "points" && hit.type === "vertex") {
    const errors = validateContoursForTaskSchema({ contours: [original], labels: LABELS, imageSize: getCurrentImageSize() });
    if (errors.length) throw new Error(errors[0]);
    interaction.type = "point";
    interaction.pointIndex = hit.pointIndex;
    interaction.radius = state.softDrag ? state.softRadius / state.scale : 0;
    state.selectedPoint = { contourId: hit.contour.id, index: hit.pointIndex };
  } else if (state.editTool === "points") {
    renderAll();
    return;
  }
  state.interaction = interaction;
  renderAll();
}

function handlePointerDown(event) {
  if (state.projectOperationBusy || !state.image || state.interaction) {
    return;
  }
  if (shouldPanCanvas(event) && startStagePan(event, elements.canvas)) {
    return;
  }
  if (event.button !== 0) {
    return;
  }
  elements.canvas.focus({ preventScroll: true });
  elements.canvas.setPointerCapture(event.pointerId);
  const point = toCanvasPoint(event);
  if (state.mode === "draw") {
    handleDrawPointerDown(point);
  } else {
    try {
      handleRefinePointerDown(point, event);
    } catch (error) {
      state.interaction = null;
      state.selectedPoint = null;
      if (elements.canvas.hasPointerCapture(event.pointerId)) elements.canvas.releasePointerCapture(event.pointerId);
      renderAll();
      setStatus(error.message || "This curve edit could not be applied.", true);
    }
  }
}

function handlePointerMove(event) {
  if (state.projectOperationBusy || !state.image) {
    return;
  }
  if (state.interaction?.type === "pan") {
    updateStagePan(event, state.interaction);
    return;
  }
  const point = toCanvasPoint(event);
  elements.cursorMeta.textContent = `x ${Math.round(point.x)}, y ${Math.round(point.y)}`;
  state.hoverPoint = point;
  if (state.addPointArmed) {
    const contour = state.contours.find((candidate) => candidate.id === state.selectedId);
    const hit = contour && editing.hitContours({ contours: [contour], selectedId: contour.id, point, tolerance: HIT_RADIUS / state.scale });
    state.addPointCandidate = hit?.type === "edge" ? hit.point : null;
    elements.canvas.style.cursor = "crosshair";
    drawCanvas();
    return;
  }
  if (state.editTool === "redraw" && state.mode === "refine") { drawCanvas(); return; }
  if (state.mode === "draw") {
    state.hoverPoint = point;
    drawCanvas();
    return;
  }

  const interaction = state.interaction;
  if (!interaction) {
    const curveHit = hitTest(point);
    const hit = curveHit?.type === "vertex" ? curveHit : hitLabel(point) || curveHit;
    if (hit?.type === "vertex") {
      elements.canvas.style.cursor = "grab";
    } else if (hit && state.editTool === "transform") {
      elements.canvas.style.cursor = "move";
    } else {
      elements.canvas.style.cursor = "default";
    }
    if (state.softDrag) drawCanvas();
    return;
  }
  if (event.pointerId !== interaction.pointerId) return;
  if (!(event.buttons & 1)) { handlePointerUp(event); return; }
  if (interaction.type === "point") {
    if (distance(point, interaction.startPoint) * state.scale < 2 && !interaction.moved) return;
    interaction.moved = true;
    replaceContour(editing.moveCurvePoint({ contour: interaction.original, pointIndex: interaction.pointIndex, point,
      imageSize: getCurrentImageSize(), radius: interaction.radius }));
    state.selectedPoint = { contourId: interaction.contourId, index: interaction.pointIndex };
    drawCanvas();
    return;
  }
  const options = { contour: interaction.original, imageSize: getCurrentImageSize(), pivot: { x: 0, y: 0 } };
  if (interaction.type === "transform") {
    const { handle } = interaction;
    options.pivot = handle.pivot;
    if (handle.name === "rotate") {
      options.angle = Math.atan2(point.y - handle.pivot.y, point.x - handle.pivot.x)
        - Math.atan2(interaction.startPoint.y - handle.pivot.y, interaction.startPoint.x - handle.pivot.x);
    } else {
      const x = handle.point.x - handle.pivot.x, y = handle.point.y - handle.pivot.y;
      options.scaleX = Math.abs(x) > 0.00001 ? Math.max(0.02, (point.x - handle.pivot.x) / x) : 1;
      options.scaleY = Math.abs(y) > 0.00001 ? Math.max(0.02, (point.y - handle.pivot.y) / y) : 1;
      if (event.shiftKey) {
        const ratio = Math.abs(options.scaleX - 1) >= Math.abs(options.scaleY - 1) ? options.scaleX : options.scaleY;
        options.scaleX = ratio; options.scaleY = ratio;
      }
    }
  } else {
    options.dx = point.x - interaction.startPoint.x;
    options.dy = point.y - interaction.startPoint.y;
  }
  replaceContour(editing.transformContour(options));
  drawCanvas();
}

function handlePointerUp(event) {
  if (state.interaction?.type === "pan") {
    finishStagePan(event);
    return;
  }
  if (state.interaction && state.interaction.pointerId !== event.pointerId) return;
  if (!state.interaction) {
    if (elements.canvas.hasPointerCapture?.(event.pointerId)) elements.canvas.releasePointerCapture(event.pointerId);
    return;
  }
  const interaction = state.interaction;
  state.interaction = null;
  if (elements.canvas.hasPointerCapture?.(event.pointerId)) elements.canvas.releasePointerCapture(event.pointerId);
  const changed = interaction.previousSnapshot !== snapshotContours();
  commitChange(interaction.previousSnapshot);
  renderAll();
  setStatus(changed ? (interaction.type === "point" ? "Point edited." : "Contour transformed.") : "Selected. Right-drag to pan · Scroll to zoom.");
}

function handleStagePointerDown(event) {
  if (
    state.projectOperationBusy ||
    event.target !== elements.stageShell ||
    (event.button !== 0 && !shouldPanCanvas(event))
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
    if (state.folderWorkspace) {
      const payload = state.folderWorkspace.buildImageFile(getCurrentProjectImageRecord());
      downloadJsonPayload(payload, `${getCurrentProjectImageRecord().name}.json`);
      setStatus(localSaveFailed ? "Current JSON downloaded. Output-folder saving still needs attention." : "Current JSON downloaded; all saved images are in your output folder.", localSaveFailed);
      return;
    }
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

async function restoreFolderImage(file) {
  setProjectOperationBusy(true);
  try {
    await flushProjectSaves();
    syncCurrentProjectImage();
    const current = getCurrentProjectImageRecord();
    const original = state.folderWorkspace.buildImageFile(current);
    const data = await readJsonFile(file);
    let restored;
    if (data?.kind === FOLDER_IMAGE_KIND) {
      restored = validateFolderImage({ data, path: current.path });
      if (restored.source.sha256 !== original.source.sha256 || restored.source.size !== original.source.size) throw new Error("This JSON belongs to a different original image. Nothing was changed.");
    } else {
      // Allows existing browser-project backups to be recovered one image at a time.
      const annotations = parseAnnotationFile({ data, labels: LABELS, createId });
      const match = annotations.images.find((image) => image.relativePath === current.path);
      if (!match) throw new Error("The JSON has no annotation for the current image path.");
      restored = { ...original, ...match, relativePath: current.path, draft: { points: [], label: state.activeLabel, closed: state.drawClosed } };
    }
    if (restored.width !== current.width || restored.height !== current.height) throw new Error("The JSON image dimensions do not match the current image.");
    if (!window.confirm("Replace the current image's contours and unfinished drawing with this JSON? Other images are not changed.")) return;
    state.contours = geometry.cloneContours(restored.contours);
    state.selectedPoint = null;
    state.selectedId = restored.selectedId || state.contours[0]?.id || null;
    state.draftPoints = restored.draft.points.map((point) => ({ ...point }));
    state.activeLabel = restored.draft.label;
    state.drawClosed = restored.draft.closed;
    if (state.draftPoints.length) state.mode = "draw";
    current.status = restored.status;
    state.undoStack = [];
    state.redoStack = [];
    scheduleProjectSave();
    await flushProjectSaves();
    setStatus("Current image restored and saved to the output folder.");
  } catch (error) {
    console.error("Current folder annotation could not be restored.", error);
    setStatus(error.message || "Restore failed. Current edits remain available for download.", true);
  } finally {
    setProjectOperationBusy(false);
    renderAll();
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
  if (state.folderWorkspace) { await restoreFolderImage(file); return; }
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
    state.redraw || state.deletePreview ||
    (state.interaction && state.interaction.type !== "pan") ||
    (!state.folderWorkspace && state.draftPoints.length) ||
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

function closeWorkspaceMenu(menu) {
  const hadFocus = menu.contains(document.activeElement);
  menu.open = false;
  if (hadFocus) menu.querySelector("summary").focus({ preventScroll: true });
}

function toggleInspector(open) {
  elements.contourInspector.classList.toggle("is-open", open);
  elements.inspectorToggle.setAttribute("aria-expanded", String(open));
  if (open) elements.closeInspector.focus({ preventScroll: true });
  else elements.inspectorToggle.focus({ preventScroll: true });
}

function wireEvents() {
  const menus = [elements.fileMenu, elements.imageQueueDisclosure, elements.moreActionsDisclosure];
  menus.forEach((menu) => menu.addEventListener("toggle", () => {
    if (menu.open) menus.filter((other) => other !== menu).forEach((other) => { other.open = false; });
  }));
  document.addEventListener("pointerdown", (event) => menus.forEach((menu) => {
    if (menu.open && !menu.contains(event.target)) closeWorkspaceMenu(menu);
  }));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const openMenu = menus.find((menu) => menu.open);
    if (openMenu) { closeWorkspaceMenu(openMenu); event.preventDefault(); event.stopImmediatePropagation(); }
    else if (elements.contourInspector.classList.contains("is-open")) {
      toggleInspector(false); event.preventDefault(); event.stopImmediatePropagation();
    }
  });
  elements.inspectorToggle.addEventListener("click", () => toggleInspector(!elements.contourInspector.classList.contains("is-open")));
  elements.closeInspector.addEventListener("click", () => toggleInspector(false));
  elements.retrySaveButton.addEventListener("click", retryCurrentSave);
  elements.backupAnnotationsButton.addEventListener("click", exportAnnotations);
  elements.addPointButton.addEventListener("click", () => {
    if (state.projectOperationBusy || state.interaction || state.redraw || state.deletePreview || !state.selectedId) return;
    state.addPointArmed = !state.addPointArmed;
    state.addPointCandidate = null;
    renderAll();
    elements.canvas.focus({ preventScroll: true });
  });
  elements.applyDeleteButton.addEventListener("click", applyPointDeletion);
  elements.cancelDeleteButton.addEventListener("click", cancelPointDeletion);
  elements.newContourLabel.addEventListener("change", (event) => {
    if (state.projectOperationBusy) return;
    const nextLabel = event.target.value;
    const nextClosed = normalizeClosedForLabel(nextLabel);
    if (state.draftPoints.length && nextClosed !== state.drawClosed) {
      event.target.value = state.activeLabel;
      setStatus("Finish or cancel the current contour before changing its shape type.", true);
      return;
    }
    state.activeLabel = nextLabel;
    if (!state.draftPoints.length) state.drawClosed = nextClosed;
    renderAll(); scheduleDraftSave();
  });
  elements.selectedContourLabel.addEventListener("change", (event) => {
    const contour = state.contours.find((candidate) => candidate.id === state.selectedId);
    if (!contour || state.projectOperationBusy || state.interaction || state.redraw || state.deletePreview) return;
    const label = event.target.value;
    if (!isShapeAllowed(label, contour.closed)) {
      event.target.value = contour.label;
      setStatus(`${getLabel(label).name} does not allow ${getShapeType(contour.closed)}.`, true);
      return;
    }
    const previous = snapshotContours();
    contour.label = label;
    commitChange(previous); renderAll();
  });
  elements.openDirectoryButton.addEventListener("click", chooseImageDirectory);
  elements.chooseOutputButton.addEventListener("click", chooseOutputDirectory);
  elements.saveNowButton.addEventListener("click", retryCurrentSave);
  elements.queuePreviousPage.addEventListener("click", () => { state.queuePage = Math.max(0, state.queuePage - 1); renderProjectPanel(); });
  elements.queueNextPage.addEventListener("click", () => { state.queuePage += 1; renderProjectPanel(); });
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
  elements.deletePointButton.addEventListener("click", deleteSelectedPoint);
  elements.applyRedrawButton.addEventListener("click", applyRedraw);
  elements.cancelRedrawButton.addEventListener("click", cancelRedraw);
  elements.alternateRedrawButton.addEventListener("click", () => {
    if (!state.redraw?.end || state.projectOperationBusy) return;
    state.redraw.alternate = !state.redraw.alternate;
    updateRedrawPreview();
  });
  elements.editToolButtons.forEach((button) => button.addEventListener("click", () => {
    if (state.projectOperationBusy || state.interaction || !confirmDiscardRedraw()) return;
    state.editTool = button.dataset.editTool;
    state.mode = "refine";
    resetPointInsertion();
    state.selectedPoint = null;
    state.hoverPoint = null;
    renderAll();
  }));
  elements.zoomOutButton.addEventListener("click", () => zoomImage(-1));
  elements.zoomInButton.addEventListener("click", () => zoomImage(1));
  elements.zoomFitButton.addEventListener("click", resetImageZoom);

  elements.softDragToggle.addEventListener("change", (event) => {
    state.softDrag = event.target.checked;
    scheduleDraftSave();
    drawCanvas();
    setStatus(state.softDrag ? "Soft edit enabled. Nearby points follow your drag; no points are added." : "Direct point editing enabled.");
  });

  elements.showPointsToggle.addEventListener("change", (event) => {
    state.showPoints = event.target.checked;
    renderAll();
    scheduleDraftSave();
    setStatus(
      state.showPoints
        ? "Point handles shown."
        : "Point handles hidden. Double-click a line to add a point, or use Transform to move the contour.",
    );
  });

  elements.softRadiusInput.addEventListener("input", (event) => {
    state.softRadius = finiteNumber(event.target.value, DEFAULT_SOFT_RADIUS);
    elements.softRadiusValue.textContent = `${state.softRadius} px`;
    drawCanvas();
    scheduleDraftSave();
  });

  document.querySelectorAll(".mode-button").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });
  elements.shapeModeButtons.forEach((button) => {
    button.addEventListener("click", () => setDrawClosed(button.dataset.shape === "closed"));
  });

  elements.canvas.addEventListener("pointerdown", handlePointerDown);
  elements.canvas.addEventListener("dblclick", (event) => {
    if (event.button !== 0 || state.spacePressed) return;
    event.preventDefault();
    insertPointAt(toCanvasPoint(event));
  });
  elements.canvas.addEventListener("pointerleave", () => {
    state.addPointCandidate = null;
    drawCanvas();
  });
  elements.canvas.addEventListener("pointermove", handlePointerMove);
  elements.canvas.addEventListener("pointerup", handlePointerUp);
  elements.canvas.addEventListener("pointercancel", (event) => {
    if (state.interaction && state.interaction.pointerId !== event.pointerId) return;
    if (state.interaction?.type === "pan") {
      finishStagePan(event);
      return;
    }
    if (state.interaction?.previousSnapshot) commitChange(state.interaction.previousSnapshot);
    state.interaction = null;
    renderAll();
  });
  elements.stageShell.addEventListener("pointerdown", handleStagePointerDown);
  elements.stageShell.addEventListener("pointermove", handleStagePointerMove);
  elements.stageShell.addEventListener("pointerup", handleStagePointerUp);
  elements.stageShell.addEventListener("pointercancel", handleStagePointerUp);
  elements.stageShell.addEventListener("lostpointercapture", handleStagePointerUp);
  elements.stageShell.addEventListener("contextmenu", (event) => {
    // Reserve right-drag for panning only inside the loaded image workspace.
    if (state.image) event.preventDefault();
  });
  elements.stageShell.addEventListener("wheel", (event) => {
    if (!state.image || state.projectOperationBusy || state.interaction) return;
    event.preventDefault();
    zoomImage(event.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  elements.canvas.addEventListener("lostpointercapture", (event) => {
    if (state.interaction?.type !== "pan" && state.interaction?.pointerId === event.pointerId) handlePointerUp(event);
  });

  window.addEventListener("blur", () => {
    state.spacePressed = false;
    if (state.interaction?.type === "pan") {
      finishStagePan(state.interaction);
    } else if (state.interaction) {
      handlePointerUp(state.interaction);
    }
  });

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
      if (event.repeat || state.interaction || state.deletePreview) return;
      if (state.redraw) {
        state.redraw.preview = null; state.redraw.end = null;
        state.redraw.points.pop(); renderAll();
      } else if (state.mode === "refine" && state.editTool === "points") deleteSelectedPoint();
      else if (state.mode === "draw" && state.draftPoints.length) {
        state.draftPoints.pop(); scheduleDraftSave(); renderAll();
      }
    }
    if (event.key === "Enter" && state.deletePreview) { event.preventDefault(); applyPointDeletion(); return; }
    if (event.key === "Escape" && state.deletePreview) { event.preventDefault(); cancelPointDeletion(); return; }
    if (event.key === "Escape" && state.addPointArmed) { event.preventDefault(); resetPointInsertion(); renderAll(); return; }
    if (event.key === "Enter" && state.redraw) { event.preventDefault(); applyRedraw(); }
    if (event.key === "Escape" && state.redraw) { event.preventDefault(); cancelRedraw(); }
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
  elements.folderSupportNote.textContent = supportsFolderWorkspace()
    ? "Desktop Chrome / Edge. For large ZIPs, extract them first. Original images are never modified."
    : "Direct folder access needs desktop Chrome / Edge on HTTPS or localhost. Browser imports remain available below.";
  await ensurePersistentStorage();
  elements.hubStorageNote.innerHTML = "<strong>Annotations saved to your folder</strong>Folder projects write JSON files to your chosen output directory. Back up that directory. Browser-imported projects still need exported backups.";
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
