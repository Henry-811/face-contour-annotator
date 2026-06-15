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
} from "./config.js";
import * as geometry from "./geometry.js";
import * as storage from "./storage.js";
import {
  buildAnnotationExport,
  buildProjectExport,
  buildTaskSchema,
  getImageSize,
  normalizeImportedContours as normalizeImportedContourData,
  validateContoursForTaskSchema,
} from "./exporter.js";
import {
  createAnnotationProject,
  createImageId,
  createProjectImage,
  getAdjacentImageId,
  getCurrentImage,
  getFilePath,
  getImageIndex,
  getProgress,
  hydrateProjectImages,
  isImageStatus,
  touchProject,
} from "./project.js";
import {
  applyCanvasScale,
  drawAnnotationCanvas,
  getFitCanvasScale,
  getDisplayContourEntries,
  hitContourLabel,
} from "./renderer.js";
import { buildDefaultFeatureContours } from "./templates.js";
const state = {
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
  projectSavePromise: Promise.resolve(),
};

const elements = {
  canvas: document.getElementById("annotationCanvas"),
  stageShell: document.getElementById("stageShell"),
  emptyState: document.getElementById("emptyState"),
  imageInput: document.getElementById("imageInput"),
  folderInput: document.getElementById("folderInput"),
  jsonInput: document.getElementById("jsonInput"),
  openImageButton: document.getElementById("openImageButton"),
  openFolderButton: document.getElementById("openFolderButton"),
  emptyOpenButton: document.getElementById("emptyOpenButton"),
  projectPosition: document.getElementById("projectPosition"),
  projectName: document.getElementById("projectName"),
  projectProgress: document.getElementById("projectProgress"),
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
  downloadButton: document.getElementById("downloadButton"),
  importButton: document.getElementById("importButton"),
  undoButton: document.getElementById("undoButton"),
  redoButton: document.getElementById("redoButton"),
  deleteButton: document.getElementById("deleteButton"),
  initializeTemplateButton: document.getElementById("initializeTemplateButton"),
  clearButton: document.getElementById("clearButton"),
  fitButton: document.getElementById("fitButton"),
  finishDraftButton: document.getElementById("finishDraftButton"),
  cancelDraftButton: document.getElementById("cancelDraftButton"),
};

const ctx = elements.canvas.getContext("2d");
let drawFrameId = null;

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
  elements.statusText.textContent = message;
  elements.statusText.style.color = isError ? "var(--hot)" : "var(--muted)";
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

function getStoredProject() {
  return storage.getCurrentProject();
}

function putStoredProject(project) {
  return storage.putCurrentProject(project);
}

function clearStoredProjectData() {
  return storage.clearCurrentProjectData();
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

async function clearStoredProject() {
  try {
    await clearStoredProjectData();
  } catch (error) {
    console.warn("Stored project could not be cleared.", error);
  }
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
  elements.zoomOutButton.disabled = !hasImage || state.imageZoom <= MIN_IMAGE_ZOOM;
  elements.zoomInButton.disabled = !hasImage || state.imageZoom >= MAX_IMAGE_ZOOM;
  elements.zoomFitButton.disabled = !hasImage || state.imageZoom === 1;
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

async function persistProjectNow() {
  if (state.draftSaveTimer) {
    window.clearTimeout(state.draftSaveTimer);
    state.draftSaveTimer = null;
  }
  if (!state.project || state.draftSaveBlocked) {
    return;
  }
  syncCurrentProjectImage();
  try {
    const imageRecord = getCurrentProjectImageRecord();
    await putStoredProject(state.project);
    if (imageRecord) {
      await storage.putProjectImageRecord(imageRecord);
    }
  } catch (error) {
    state.draftSaveBlocked = true;
    console.warn("Project could not be saved.", error);
    setStatus("Project draft could not be saved. Export JSON to keep annotations.", true);
  }
}

function queueProjectSave() {
  if (!state.project || state.draftSaveBlocked) {
    return Promise.resolve();
  }
  state.projectSavePromise = state.projectSavePromise
    .catch(() => undefined)
    .then(() => persistProjectNow());
  return state.projectSavePromise;
}

function persistAnnotationChange() {
  if (!state.project) {
    scheduleDraftSave();
    return;
  }
  if (state.draftSaveTimer) {
    window.clearTimeout(state.draftSaveTimer);
    state.draftSaveTimer = null;
  }
  queueProjectSave();
}

function scheduleProjectSave() {
  if (!state.project || state.draftSaveBlocked) {
    return;
  }
  if (state.draftSaveTimer) {
    window.clearTimeout(state.draftSaveTimer);
  }
  state.draftSaveTimer = window.setTimeout(() => {
    queueProjectSave();
  }, DRAFT_SAVE_DELAY_MS);
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

function syncModeControls() {
  document.querySelectorAll(".mode-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === state.mode);
  });
  elements.canvas.style.cursor = state.mode === "draw" ? "crosshair" : "default";
}

function syncShapeControls() {
  elements.shapeModeButtons.forEach((button) => {
    const closed = button.dataset.shape === "closed";
    button.classList.toggle("is-active", closed === state.drawClosed);
    button.disabled = !isShapeAllowed(state.activeLabel, closed);
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
  syncModeControls();
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

function buildExport() {
  if (state.project) {
    syncCurrentProjectImage();
    return buildProjectExport({
      project: state.project,
      labels: LABELS,
    });
  }
  return buildAnnotationExport({
    image: state.image,
    fileName: state.fileName,
    labels: LABELS,
    contours: state.contours,
  });
}

function updateJsonOutput() {
  elements.jsonOutput.value = JSON.stringify(buildExport(), null, 2);
}

function updateCommandState() {
  elements.undoButton.disabled = state.undoStack.length === 0;
  elements.redoButton.disabled = state.redoStack.length === 0;
  elements.deleteButton.disabled = !state.selectedId;
  elements.initializeTemplateButton.disabled = !canInitializeFeatureTemplate();
  elements.clearButton.disabled = state.contours.length === 0;
  elements.downloadButton.disabled = !state.project && !state.image;
  elements.finishDraftButton.disabled =
    state.draftPoints.length < getMinimumPoints(state.drawClosed) ||
    !isShapeAllowed(state.activeLabel, state.drawClosed);
  elements.finishDraftButton.textContent = state.drawClosed ? "Finish Region" : "Finish Line";
  elements.cancelDraftButton.disabled = state.draftPoints.length === 0;
  elements.densifyButton.disabled = !state.selectedId;
  elements.shapeHint.textContent = `${getLabel(state.activeLabel).name}: ${getDrawShapeName()} mode. ${
    state.drawClosed
      ? "Enter finishes a region; clicking the first point closes it."
      : "Enter finishes a line; clicking the first point stays open."
  }`;
  elements.showPointsToggle.checked = state.showPoints;
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
  elements.projectName.textContent = project?.name || "No project";
  elements.projectProgress.textContent = `${progress.done} done, ${progress.in_progress} active`;
  elements.previousImageButton.disabled = !getAdjacentImageId(project, -1);
  elements.nextImageButton.disabled = !getAdjacentImageId(project, 1);
  const hasImage = Boolean(getCurrentProjectImageRecord());
  elements.markDoneButton.disabled = !hasImage;
  elements.skipImageButton.disabled = !hasImage;
  elements.needsReviewButton.disabled = !hasImage;
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
  syncModeControls();
  elements.softDragToggle.checked = state.softDrag;
  elements.showPointsToggle.checked = state.showPoints;
  elements.softRadiusInput.value = String(state.softRadius);
  renderTopbar();
  renderProjectPanel();
  renderContourList();
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
      let nextContours = [];
      let templateInitialized = false;
      try {
        nextContours = Array.isArray(options.contours)
          ? normalizeImportedContours(options.contours, getImageSize(image))
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
      state.draftSaveBlocked = false;
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

function getImageFiles(fileList) {
  return Array.from(fileList || []).filter((file) => file.type.startsWith("image/"));
}

async function createProjectImageFromFile(file, index) {
  const dataUrl = await readImageFileAsDataUrl(file);
  const image = await loadImageElement(dataUrl);
  assertAnnotatableImage(image, file.name);
  const contours = buildInitialFeatureTemplateContours(image);
  return createProjectImage({
    id: createImageId(index),
    name: file.name,
    path: getFilePath(file),
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
  const storedAsset = imageRecord.dataUrl
    ? { dataUrl: imageRecord.dataUrl }
    : await storage.getProjectImageAsset(imageRecord.id);
  if (!storedAsset?.dataUrl) {
    setStatus("Stored image data is missing. Reopen the image batch to continue.", true);
    return false;
  }
  state.currentImageId = imageRecord.id;
  state.project.currentImageId = imageRecord.id;
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
    status: options.status || `Loaded ${imageRecord.path || imageRecord.name}.`,
  });
}

async function openProjectFromFiles(fileList, sourceType = "files") {
  const files = getImageFiles(fileList);
  if (!files.length) {
    setStatus("Choose at least one image file.", true);
    return;
  }
  setStatus(`Importing ${files.length} image${files.length === 1 ? "" : "s"}...`);
  try {
    const images = [];
    for (let index = 0; index < files.length; index += 1) {
      images.push(await createProjectImageFromFile(files[index], index));
    }
    state.project = createAnnotationProject({
      name: files.length === 1 ? files[0].name : `${files.length} image project`,
      images,
      taskSchema: buildTaskSchema(LABELS),
      sourceType,
      preferences: buildProjectPreferences(),
    });
    state.currentImageId = state.project.currentImageId;
    clearStoredDraft();
    await clearStoredProjectData();
    await putStoredProject(state.project);
    await storage.putProjectImageRecords(state.project.images);
    await storage.putProjectImageAssets(state.project.images);
    await loadProjectImageRecord(getCurrentImage(state.project), {
      status: `${files.length} image${files.length === 1 ? "" : "s"} imported.`,
    });
    await persistProjectNow();
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : "Image project could not be imported.", true);
  }
}

async function switchToProjectImage(imageId) {
  if (!state.project || !imageId || imageId === state.currentImageId) {
    return;
  }
  const imageRecord = state.project.images.find((image) => image.id === imageId);
  if (!imageRecord) {
    setStatus("Project image could not be found.", true);
    return;
  }
  await persistProjectNow();
  await loadProjectImageRecord(imageRecord);
  scheduleDraftSave();
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
  await persistProjectNow();
  renderAll();
  setStatus(`${imageRecord.path || imageRecord.name} marked ${getStatusLabel(status)}.`);
}

function validateDoneImagesForExport(project = state.project) {
  if (!project) {
    return [];
  }
  const errors = [];
  project.images.forEach((image) => {
    if (image.status !== "done") {
      return;
    }
    const imageErrors = validateImageForDone(image);
    imageErrors.forEach((error) => {
      errors.push(`${image.path || image.name}: ${error}`);
    });
  });
  return errors;
}

async function restoreDraft() {
  let restoringProject = false;
  try {
    if (new URLSearchParams(window.location.search).get("resetDraft") === "1") {
      clearStoredDraft();
      await clearStoredProject();
      setStatus("Saved draft cleared.");
      return false;
    }
    const project = await getStoredProject();
    if (project?.version === "face-contour-project-v1" && Array.isArray(project.images)) {
      restoringProject = true;
      const imageIds = project.images.map((image) => image.id).filter(Boolean);
      const imageRecords = await storage.getProjectImageRecords(imageIds);
      state.project = hydrateProjectImages(project, imageRecords);
      state.currentImageId = project.currentImageId || project.images[0]?.id || null;
      applyProjectPreferences(project.preferences);
      const legacyImages = state.project.images.filter((image) => image.dataUrl);
      const missingRecords = imageRecords.some((image) => !image);
      if (legacyImages.length || missingRecords) {
        await putStoredProject(state.project);
        await storage.putProjectImageRecords(state.project.images);
        await storage.putProjectImageAssets(legacyImages);
      }
      const imageRecord = getCurrentImage(state.project);
      const restored = await loadProjectImageRecord(imageRecord, {
        status: "Restored saved project.",
      });
      if (!restored) {
        throw new Error("Stored project image data is missing.");
      }
      return true;
    }
    const raw = storage.readStoredDraft(DRAFT_STORAGE_KEY);
    if (!raw) {
      return false;
    }
    if (raw.length > MAX_LEGACY_DRAFT_BYTES && raw.includes('"src"')) {
      clearStoredDraft();
      setStatus("Large legacy draft skipped. Reopen the image to continue.", true);
      return false;
    }
    const draft = JSON.parse(raw);
    if (draft?.version === 1 && typeof draft.image?.src === "string") {
      await loadImageDataUrl(draft.image.src, draft.image.name, {
        contours: draft.contours,
        selectedId: draft.selectedId,
        activeLabel: draft.activeLabel,
        mode: draft.mode,
        drawClosed: draft.drawClosed,
        softDrag: draft.softDrag,
        showPoints: draft.showPoints,
        softRadius: draft.softRadius,
        imageZoom: draft.imageZoom,
        status: "Restored saved image.",
        errorStatus: "Saved image could not be restored.",
        clearOnError: true,
      });
      return true;
    }
    if (draft?.version !== 2 || !draft.image?.stored) {
      throw new Error("Stored draft has an unsupported format.");
    }
    setStatus("Restoring saved image...");
    const storedImage = await getStoredImage();
    if (!storedImage?.dataUrl) {
      throw new Error("Stored draft image is missing.");
    }
    await loadImageDataUrl(storedImage.dataUrl, draft.image.name, {
      contours: draft.contours,
      selectedId: draft.selectedId,
      activeLabel: draft.activeLabel,
      mode: draft.mode,
      drawClosed: draft.drawClosed,
      softDrag: draft.softDrag,
      showPoints: draft.showPoints,
      softRadius: draft.softRadius,
      imageZoom: draft.imageZoom,
      status: "Restored saved image.",
      errorStatus: "Saved image could not be restored.",
      clearOnError: true,
      imageStored: true,
      persist: false,
    });
    return true;
  } catch (error) {
    console.warn("Stored draft could not be restored.", error);
    clearStoredDraft();
    if (restoringProject) {
      await clearStoredProject();
    }
    return false;
  }
}

function openImageFile(file) {
  openProjectFromFiles(file ? [file] : [], "files");
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
  if (!state.image) {
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
  if (event.target !== elements.stageShell || event.button !== 0) {
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

function downloadJson() {
  if (!state.project && !state.image) {
    setStatus("Open images before exporting.", true);
    return;
  }
  syncCurrentProjectImage();
  const exportErrors = validateDoneImagesForExport();
  if (exportErrors.length) {
    setStatus(exportErrors[0], true);
    return;
  }
  const json = JSON.stringify(buildExport(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const baseName = state.project
    ? state.project.name.replace(/\s+/g, "-").toLowerCase()
    : state.fileName.replace(/\.[^.]+$/, "") || "contours";
  link.href = url;
  link.download = state.project
    ? `${baseName}.face-contour-project.json`
    : `${baseName}.face-contours.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus(state.project ? "Project JSON exported." : "JSON downloaded.");
}

function normalizeImportedContours(contours, imageSize = getCurrentImageSize()) {
  return normalizeImportedContourData({
    contours,
    labels: LABELS,
    imageSize,
    createId,
    minOpenPoints: MIN_OPEN_POINTS,
    minClosedPoints: MIN_CLOSED_POINTS,
  });
}

function importJsonFile(file) {
  if (!state.image) {
    setStatus("Open the matching image before importing JSON.", true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      const importedContours = normalizeImportedContours(data.contours);
      const previous = snapshotContours();
      state.contours = importedContours;
      state.selectedId = state.contours[0]?.id || null;
      state.draftPoints = [];
      state.hoverPoint = null;
      commitChange(previous);
      renderAll();
      setStatus("JSON imported.");
    } catch (error) {
      console.error(error);
      setStatus("JSON import failed.", true);
    }
  };
  reader.onerror = () => setStatus("JSON file could not be read.", true);
  reader.readAsText(file);
}

function wireEvents() {
  elements.openImageButton.addEventListener("click", () => elements.imageInput.click());
  elements.openFolderButton.addEventListener("click", () => elements.folderInput.click());
  elements.emptyOpenButton.addEventListener("click", () => elements.imageInput.click());
  elements.imageInput.addEventListener("change", (event) => {
    openProjectFromFiles(event.target.files, "files");
    event.target.value = "";
  });
  elements.folderInput.addEventListener("change", (event) => {
    openProjectFromFiles(event.target.files, "folder");
    event.target.value = "";
  });

  elements.importButton.addEventListener("click", () => elements.jsonInput.click());
  elements.jsonInput.addEventListener("change", (event) => {
    importJsonFile(event.target.files[0]);
    event.target.value = "";
  });

  elements.downloadButton.addEventListener("click", downloadJson);
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
  elements.fitButton.addEventListener("click", () => {
    resetImageZoom();
  });

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
  window.addEventListener("keydown", (event) => {
    const activeTag = document.activeElement?.tagName;
    const isEditingField =
      activeTag === "INPUT" || activeTag === "TEXTAREA" || activeTag === "SELECT";
    if (event.code === "Space" && !isEditingField) {
      state.spacePressed = true;
      if (state.image) {
        event.preventDefault();
      }
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && !isEditingField) {
      event.preventDefault();
      deleteSelected();
    }
    if (event.key === "Enter" && state.mode === "draw" && !isEditingField) {
      event.preventDefault();
      finishDraftWithDefault();
    }
    if (event.key === "Escape" && state.mode === "draw" && !isEditingField) {
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
    if (state.image) {
      event.preventDefault();
    }
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    elements.stageShell.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.stageShell.classList.add("is-drag-over");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    elements.stageShell.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.stageShell.classList.remove("is-drag-over");
    });
  });
  elements.stageShell.addEventListener("drop", (event) => {
    openProjectFromFiles(event.dataTransfer.files, "drop");
  });
}

async function init() {
  configureSoftRadiusInput();
  renderLabels();
  renderAll();
  wireEvents();
  if (!(await restoreDraft())) {
    drawCanvas();
  }
}

init().catch((error) => {
  console.error(error);
  setStatus("App could not finish startup.", true);
  drawCanvas();
});
