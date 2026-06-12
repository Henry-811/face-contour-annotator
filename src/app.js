import {
  DENSIFY_SPACING,
  DRAFT_SAVE_DELAY_MS,
  DRAFT_STORAGE_KEY,
  HIT_RADIUS,
  LABELS,
  LINE_HIT_RADIUS,
  MAX_CONTROL_HANDLES,
  MAX_LEGACY_DRAFT_BYTES,
  MIN_CLOSED_POINTS,
  MIN_OPEN_POINTS,
  POINT_RADIUS,
  SOFT_DRAG_MAX_DISTANCE,
  SOFT_DRAG_MIN_DISTANCE,
  SOFT_DRAG_RADIUS_RATIO,
} from "./config.js";
import * as geometry from "./geometry.js";
import * as storage from "./storage.js";
import {
  buildAnnotationExport,
  getImageSize,
  normalizeImportedContours as normalizeImportedContourData,
} from "./exporter.js";
import { drawAnnotationCanvas, fitCanvasToImage } from "./renderer.js";
const state = {
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
  softRadius: 40,
  scale: 1,
  interaction: null,
  undoStack: [],
  redoStack: [],
  draftSaveTimer: null,
  draftSaveBlocked: false,
};

const elements = {
  canvas: document.getElementById("annotationCanvas"),
  stageShell: document.getElementById("stageShell"),
  emptyState: document.getElementById("emptyState"),
  imageInput: document.getElementById("imageInput"),
  jsonInput: document.getElementById("jsonInput"),
  openImageButton: document.getElementById("openImageButton"),
  emptyOpenButton: document.getElementById("emptyOpenButton"),
  fileMeta: document.getElementById("fileMeta"),
  imageSize: document.getElementById("imageSize"),
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
    selectedId: state.selectedId,
    contours: cloneContours(),
  };
}

async function persistDraftNow() {
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

function cloneContours(contours = state.contours) {
  return geometry.cloneContours(contours);
}

function snapshotContours() {
  return JSON.stringify(state.contours);
}

function restoreContours(snapshot) {
  state.contours = JSON.parse(snapshot);
  if (!state.contours.some((contour) => contour.id === state.selectedId)) {
    state.selectedId = state.contours[0]?.id || null;
  }
  scheduleDraftSave();
  renderAll();
}

function commitChange(previousSnapshot) {
  const currentSnapshot = snapshotContours();
  if (currentSnapshot === previousSnapshot) {
    return;
  }
  state.undoStack.push(previousSnapshot);
  state.redoStack = [];
  updateCommandState();
  scheduleDraftSave();
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
      : "Refine mode: drag the contour line to reshape. Hold Shift inside a closed shape to move it.",
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

function buildExport() {
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
  elements.clearButton.disabled = state.contours.length === 0;
  elements.downloadButton.disabled = !state.image;
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

function fitCanvas() {
  const scale = fitCanvasToImage({
    canvas: elements.canvas,
    stageShell: elements.stageShell,
    image: state.image,
  });
  if (scale === null) {
    return;
  }
  state.scale = scale;
  drawCanvas();
}

function renderTopbar() {
  const hasImage = Boolean(state.image);
  elements.emptyState.classList.toggle("hidden", hasImage);
  elements.fileMeta.textContent = hasImage ? state.fileName : "No image loaded";
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
  renderContourList();
  updateJsonOutput();
  updateCommandState();
  drawCanvas();
}

function loadImageDataUrl(dataUrl, fileName, options = {}) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    setStatus("Saved image data is not valid.", true);
    return;
  }
  const image = new Image();
  image.onload = () => {
    let nextContours = [];
    try {
      nextContours = Array.isArray(options.contours)
        ? normalizeImportedContours(options.contours)
        : [];
    } catch (error) {
      console.warn("Saved contours could not be restored.", error);
      if (options.clearOnError) {
        clearStoredDraft();
      }
      setStatus("Saved contours could not be restored.", true);
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
    fitCanvas();
    renderAll();
    if (options.persist !== false) {
      scheduleDraftSave();
    }
    setStatus(options.status || "Image loaded.");
  };
  image.onerror = () => {
    if (options.clearOnError) {
      clearStoredDraft();
    }
    setStatus(options.errorStatus || "Image could not be loaded.", true);
  };
  image.src = dataUrl;
}

async function restoreDraft() {
  try {
    if (new URLSearchParams(window.location.search).get("resetDraft") === "1") {
      clearStoredDraft();
      setStatus("Saved draft cleared.");
      return false;
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
      loadImageDataUrl(draft.image.src, draft.image.name, {
        contours: draft.contours,
        selectedId: draft.selectedId,
        activeLabel: draft.activeLabel,
        mode: draft.mode,
        drawClosed: draft.drawClosed,
        softDrag: draft.softDrag,
        showPoints: draft.showPoints,
        softRadius: draft.softRadius,
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
    loadImageDataUrl(storedImage.dataUrl, draft.image.name, {
      contours: draft.contours,
      selectedId: draft.selectedId,
      activeLabel: draft.activeLabel,
      mode: draft.mode,
      drawClosed: draft.drawClosed,
      softDrag: draft.softDrag,
      showPoints: draft.showPoints,
      softRadius: draft.softRadius,
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
    return false;
  }
}

function openImageFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("Choose a valid image file.", true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    loadImageDataUrl(String(reader.result), file.name);
  };
  reader.onerror = () => setStatus("Image file could not be read.", true);
  reader.readAsDataURL(file);
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
    },
  });
  interaction.wasClamped = result.wasClamped;
  state.contours = result.contours;
}

function handleRefinePointerDown(point, event) {
  const hit = event?.shiftKey
    ? hitFilledContour(point) || hitTest(point)
    : hitTest(point);
  if (!hit) {
    state.selectedId = null;
    state.interaction = null;
    renderAll();
    return;
  }
  const previousSnapshot = snapshotContours();
  state.selectedId = hit.contour.id;
  if (hit.type === "vertex" && !state.softDrag) {
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
    setStatus(
      "Drag the contour line to reshape. Hold Shift and drag inside a closed shape to move it.",
    );
    return;
  }
  renderAll();
}

function handlePointerDown(event) {
  if (!state.image || event.button !== 0) {
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
    const hit = moveHit || hitTest(point);
    if (hit?.type === "vertex" || hit?.type === "edge") {
      elements.canvas.style.cursor = "grab";
    } else if (hit?.type === "contour" && event.shiftKey) {
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

function downloadJson() {
  if (!state.image) {
    setStatus("Open an image before exporting.", true);
    return;
  }
  const json = JSON.stringify(buildExport(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const baseName = state.fileName.replace(/\.[^.]+$/, "") || "contours";
  link.href = url;
  link.download = `${baseName}.face-contours.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus("JSON downloaded.");
}

function normalizeImportedContours(contours) {
  return normalizeImportedContourData({
    contours,
    labels: LABELS,
    imageSize: getCurrentImageSize(),
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
  elements.emptyOpenButton.addEventListener("click", () => elements.imageInput.click());
  elements.imageInput.addEventListener("change", (event) => {
    openImageFile(event.target.files[0]);
    event.target.value = "";
  });

  elements.importButton.addEventListener("click", () => elements.jsonInput.click());
  elements.jsonInput.addEventListener("change", (event) => {
    importJsonFile(event.target.files[0]);
    event.target.value = "";
  });

  elements.downloadButton.addEventListener("click", downloadJson);
  elements.undoButton.addEventListener("click", undo);
  elements.redoButton.addEventListener("click", redo);
  elements.deleteButton.addEventListener("click", deleteSelected);
  elements.clearButton.addEventListener("click", clearContours);
  elements.finishDraftButton.addEventListener("click", finishDraftWithDefault);
  elements.cancelDraftButton.addEventListener("click", cancelDraft);
  elements.densifyButton.addEventListener("click", densifySelectedContour);
  elements.fitButton.addEventListener("click", () => {
    fitCanvas();
    setStatus("Image fitted.");
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
    state.softRadius = finiteNumber(event.target.value, 40);
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
  elements.canvas.addEventListener("pointercancel", () => {
    state.interaction = null;
    renderAll();
  });

  window.addEventListener("resize", fitCanvas);
  window.addEventListener("keydown", (event) => {
    const activeTag = document.activeElement?.tagName;
    const isEditingField =
      activeTag === "INPUT" || activeTag === "TEXTAREA" || activeTag === "SELECT";
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
    const file = Array.from(event.dataTransfer.files).find((item) =>
      item.type.startsWith("image/"),
    );
    openImageFile(file);
  });
}

async function init() {
  renderLabels();
  updateJsonOutput();
  updateCommandState();
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
