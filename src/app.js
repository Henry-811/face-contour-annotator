const LABELS = [
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

const MIN_OPEN_POINTS = 2;
const MIN_CLOSED_POINTS = 3;
const POINT_RADIUS = 5;
const HIT_RADIUS = 10;
const LINE_HIT_RADIUS = 18;
const SOFT_DRAG_MIN_DISTANCE = 6;
const SOFT_DRAG_MAX_DISTANCE = 32;
const SOFT_DRAG_RADIUS_RATIO = 0.75;
const DENSIFY_SPACING = 10;
const MAX_CONTROL_HANDLES = 180;
const DRAFT_STORAGE_KEY = "face-contour-lab-draft-v1";
const DRAFT_DB_NAME = "face-contour-lab";
const DRAFT_DB_VERSION = 1;
const DRAFT_STORE_NAME = "draft-assets";
const DRAFT_IMAGE_KEY = "current-image";
const MAX_LEGACY_DRAFT_BYTES = 1500000;
const DRAFT_SAVE_DELAY_MS = 200;
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
  finishOpenButton: document.getElementById("finishOpenButton"),
  closeShapeButton: document.getElementById("closeShapeButton"),
  cancelDraftButton: document.getElementById("cancelDraftButton"),
};

const ctx = elements.canvas.getContext("2d");

function getLabel(labelId) {
  return LABELS.find((label) => label.id === labelId) || LABELS[0];
}

function getDefaultClosed(labelId = state.activeLabel) {
  return getLabel(labelId).defaultClosed;
}

function getMinimumPoints(closed) {
  return closed ? MIN_CLOSED_POINTS : MIN_OPEN_POINTS;
}

function getShapeName(closed) {
  return closed ? "closed shape" : "open curve";
}

function setStatus(message, isError = false) {
  elements.statusText.textContent = message;
  elements.statusText.style.color = isError ? "var(--hot)" : "var(--muted)";
}

function openDraftDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is not available."));
      return;
    }
    const request = window.indexedDB.open(DRAFT_DB_NAME, DRAFT_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        database.createObjectStore(DRAFT_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB could not be opened."));
  });
}

async function withDraftStore(mode, callback) {
  const database = await openDraftDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(DRAFT_STORE_NAME, mode);
      const store = transaction.objectStore(DRAFT_STORE_NAME);
      let callbackResult;
      transaction.oncomplete = () => resolve(callbackResult);
      transaction.onerror = () =>
        reject(transaction.error || new Error("Draft asset transaction failed."));
      transaction.onabort = () =>
        reject(transaction.error || new Error("Draft asset transaction aborted."));
      callbackResult = callback(store);
    });
  } finally {
    database.close();
  }
}

function putStoredImage(dataUrl) {
  return withDraftStore("readwrite", (store) => {
    store.put({ dataUrl, updatedAt: Date.now() }, DRAFT_IMAGE_KEY);
  });
}

function getStoredImage() {
  return withDraftStore(
    "readonly",
    (store) =>
      new Promise((resolve, reject) => {
        const request = store.get(DRAFT_IMAGE_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () =>
          reject(request.error || new Error("Stored image could not be read."));
      }),
  );
}

function deleteStoredImage() {
  return withDraftStore("readwrite", (store) => {
    store.delete(DRAFT_IMAGE_KEY);
  });
}

function clearStoredDraft() {
  if (state.draftSaveTimer) {
    window.clearTimeout(state.draftSaveTimer);
    state.draftSaveTimer = null;
  }
  try {
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
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
    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
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
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cloneContours(contours = state.contours) {
  return contours.map((contour) => ({
    ...contour,
    points: contour.points.map((point) => ({ ...point })),
  }));
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampPoint(point) {
  if (!state.image) {
    return point;
  }
  return {
    x: Math.round(clamp(finiteNumber(point.x), 0, state.image.naturalWidth)),
    y: Math.round(clamp(finiteNumber(point.y), 0, state.image.naturalHeight)),
  };
}

function normalizePoint(point) {
  return clampPoint({
    x: finiteNumber(point.x),
    y: finiteNumber(point.y),
  });
}

function toCanvasPoint(event) {
  const rect = elements.canvas.getBoundingClientRect();
  return clampPoint({
    x: (event.clientX - rect.left) / state.scale,
    y: (event.clientY - rect.top) / state.scale,
  });
}

function toDisplayPoint(point) {
  return {
    x: point.x * state.scale,
    y: point.y * state.scale,
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerp(start, end, t) {
  return start + (end - start) * t;
}

function interpolatePoint(start, end, t) {
  return {
    x: lerp(start.x, end.x, t),
    y: lerp(start.y, end.y, t),
  };
}

function getSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return { distance: distance(point, start), t: 0, projection: { ...start } };
  }
  const rawT = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const t = clamp(rawT, 0, 1);
  const projection = interpolatePoint(start, end, t);
  return { distance: distance(point, projection), t, projection };
}

function getContourSegments(contour) {
  const segments = [];
  const lastIndex = contour.closed ? contour.points.length : contour.points.length - 1;
  for (let index = 0; index < lastIndex; index += 1) {
    const nextIndex = (index + 1) % contour.points.length;
    if (contour.points[index] && contour.points[nextIndex]) {
      segments.push({ index, nextIndex });
    }
  }
  return segments;
}

function densifyPoints(points, closed, spacing = DENSIFY_SPACING) {
  if (points.length < 2) {
    return points.map((point) => ({ ...point }));
  }
  const result = [];
  const segmentCount = closed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const segmentLength = distance(start, end);
    const steps = Math.max(1, Math.ceil(segmentLength / spacing));
    result.push({ ...start });
    for (let step = 1; step < steps; step += 1) {
      result.push(interpolatePoint(start, end, step / steps));
    }
  }
  if (!closed) {
    result.push({ ...points[points.length - 1] });
  }
  return result.map(normalizePoint);
}

function getPathOffsets(contour) {
  const offsets = [0];
  for (let index = 1; index < contour.points.length; index += 1) {
    offsets[index] = offsets[index - 1] + distance(contour.points[index - 1], contour.points[index]);
  }
  const perimeter = contour.closed
    ? offsets[offsets.length - 1] +
      distance(contour.points[contour.points.length - 1], contour.points[0])
    : offsets[offsets.length - 1];
  return { offsets, perimeter };
}

function getAnchorOffset(contour, interaction) {
  const { offsets } = getPathOffsets(contour);
  if (interaction.segmentIndex !== undefined) {
    const start = contour.points[interaction.segmentIndex];
    const end = contour.points[(interaction.segmentIndex + 1) % contour.points.length];
    return offsets[interaction.segmentIndex] + distance(start, end) * interaction.segmentT;
  }
  return offsets[interaction.pointIndex] || 0;
}

function getContourPathDistance(contour, pointIndex, anchorOffset) {
  const { offsets, perimeter } = getPathOffsets(contour);
  const directDistance = Math.abs((offsets[pointIndex] || 0) - anchorOffset);
  if (!contour.closed || perimeter === 0) {
    return directDistance;
  }
  return Math.min(directDistance, perimeter - directDistance);
}

function getSoftWeight(pathDistance, radius) {
  if (pathDistance > radius) {
    return 0;
  }
  return 0.5 + 0.5 * Math.cos((Math.PI * pathDistance) / radius);
}

function getSoftDragLimit() {
  return clamp(
    state.softRadius * SOFT_DRAG_RADIUS_RATIO,
    SOFT_DRAG_MIN_DISTANCE,
    SOFT_DRAG_MAX_DISTANCE,
  );
}

function clampVector(dx, dy, maxLength) {
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length === 0 || length <= maxLength) {
    return { dx, dy, clamped: false };
  }
  const scale = maxLength / length;
  return {
    dx: dx * scale,
    dy: dy * scale,
    clamped: true,
  };
}

function getContourBounds(contour) {
  const xs = contour.points.map((point) => point.x);
  const ys = contour.points.map((point) => point.y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

function pointInPolygon(point, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i) {
    const pi = points[i];
    const pj = points[j];
    const intersects =
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function hitFilledContour(point) {
  for (let i = state.contours.length - 1; i >= 0; i -= 1) {
    const contour = state.contours[i];
    if (contour.closed && pointInPolygon(point, contour.points)) {
      return { type: "contour", contour };
    }
  }
  return null;
}

function hitTest(point) {
  for (let i = state.contours.length - 1; i >= 0; i -= 1) {
    const contour = state.contours[i];
    if (state.showPoints) {
      for (let pointIndex = 0; pointIndex < contour.points.length; pointIndex += 1) {
        if (distance(point, contour.points[pointIndex]) <= HIT_RADIUS / state.scale) {
          return { type: "vertex", contour, pointIndex };
        }
      }
    }
    for (const segment of getContourSegments(contour)) {
      const hit = getSegmentDistance(
        point,
        contour.points[segment.index],
        contour.points[segment.nextIndex],
      );
      if (hit.distance <= LINE_HIT_RADIUS / state.scale) {
        return {
          type: "edge",
          contour,
          segmentIndex: segment.index,
          segmentT: hit.t,
        };
      }
    }
    if (contour.closed && pointInPolygon(point, contour.points)) {
      return { type: "contour", contour };
    }
  }
  return null;
}

function syncModeControls() {
  document.querySelectorAll(".mode-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === state.mode);
  });
  elements.canvas.style.cursor = state.mode === "draw" ? "crosshair" : "default";
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
  finishDraft(getDefaultClosed());
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
  const image = state.image
    ? {
        name: state.fileName,
        width: state.image.naturalWidth,
        height: state.image.naturalHeight,
      }
    : null;
  return {
    version: "face-contour-annotator-v1",
    image,
    labels: LABELS.map(({ id, name, defaultClosed }) => ({ id, name, defaultClosed })),
    contours: state.contours.map((contour) => ({
      id: contour.id,
      label: contour.label,
      closed: Boolean(contour.closed),
      shape_type: contour.closed ? "polygon" : "linestrip",
      points: contour.points.map((point) => ({
        x: Math.round(point.x),
        y: Math.round(point.y),
      })),
    })),
  };
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
  elements.finishOpenButton.disabled = state.draftPoints.length < MIN_OPEN_POINTS;
  elements.closeShapeButton.disabled = state.draftPoints.length < MIN_CLOSED_POINTS;
  elements.cancelDraftButton.disabled = state.draftPoints.length === 0;
  elements.densifyButton.disabled = !state.selectedId;
  elements.shapeHint.textContent = `${getLabel(state.activeLabel).name} defaults to ${
    getDefaultClosed() ? "closed shapes" : "open curves"
  }.`;
  elements.showPointsToggle.checked = state.showPoints;
  elements.softRadiusValue.textContent = `${state.softRadius} px`;
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
      state.activeLabel = label.id;
      renderLabels();
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
    const bounds = getContourBounds(contour);
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
      const previous = snapshotContours();
      contour.label = event.target.value;
      state.activeLabel = contour.label;
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

function drawSmoothPath(displayPoints, closed) {
  if (!displayPoints.length) {
    return;
  }
  ctx.beginPath();
  if (displayPoints.length < 3) {
    ctx.moveTo(displayPoints[0].x, displayPoints[0].y);
    displayPoints.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
    return;
  }
  if (closed) {
    const last = displayPoints[displayPoints.length - 1];
    const first = displayPoints[0];
    ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
    displayPoints.forEach((point, index) => {
      const next = displayPoints[(index + 1) % displayPoints.length];
      ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
    });
    ctx.closePath();
    return;
  }
  ctx.moveTo(displayPoints[0].x, displayPoints[0].y);
  for (let index = 1; index < displayPoints.length - 1; index += 1) {
    const point = displayPoints[index];
    const next = displayPoints[index + 1];
    ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
  }
  const last = displayPoints[displayPoints.length - 1];
  ctx.lineTo(last.x, last.y);
}

function drawContour(contour, isSelected = false) {
  if (!contour.points.length) {
    return;
  }
  const label = getLabel(contour.label);
  const displayPoints = contour.points.map(toDisplayPoint);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (isSelected) {
    drawSmoothPath(displayPoints, Boolean(contour.closed));
    ctx.strokeStyle = "rgba(255, 255, 255, 0.84)";
    ctx.lineWidth = 8;
    ctx.stroke();
  }
  drawSmoothPath(displayPoints, Boolean(contour.closed));
  ctx.fillStyle = `${label.color}24`;
  ctx.strokeStyle = label.color;
  ctx.lineWidth = isSelected ? 4 : 2;
  if (contour.closed) {
    ctx.fill();
  }
  ctx.stroke();

  const anchor = displayPoints[0];
  ctx.font = "12px Aptos, Segoe UI, sans-serif";
  const textWidth = ctx.measureText(label.name).width;
  const tagWidth = Math.max(48, textWidth + 12);
  const tagY = Math.max(0, anchor.y - 24);
  ctx.fillStyle = label.color;
  ctx.fillRect(anchor.x, tagY, tagWidth, 20);
  ctx.fillStyle = "#fff";
  ctx.fillText(label.name, anchor.x + 6, tagY + 14);

  if (isSelected && state.showPoints) {
    const handleStride = Math.max(1, Math.ceil(displayPoints.length / MAX_CONTROL_HANDLES));
    displayPoints.forEach((point, pointIndex) => {
      const isEndpoint = !contour.closed && (
        pointIndex === 0 || pointIndex === displayPoints.length - 1
      );
      if (pointIndex % handleStride !== 0 && !isEndpoint) {
        return;
      }
      ctx.beginPath();
      ctx.fillStyle = pointIndex === 0 ? "#fff" : label.color;
      ctx.strokeStyle = label.color;
      ctx.lineWidth = 2;
      ctx.arc(point.x, point.y, POINT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }
  ctx.restore();
}

function drawDraft() {
  if (!state.draftPoints.length) {
    return;
  }
  const label = getLabel(state.activeLabel);
  const displayPoints = state.draftPoints.map(toDisplayPoint);
  const hoverPoint = state.hoverPoint ? toDisplayPoint(state.hoverPoint) : null;
  ctx.save();
  ctx.strokeStyle = label.color;
  ctx.fillStyle = label.color;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 5]);
  ctx.beginPath();
  ctx.moveTo(displayPoints[0].x, displayPoints[0].y);
  displayPoints.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
  if (hoverPoint) {
    ctx.lineTo(hoverPoint.x, hoverPoint.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  displayPoints.forEach((point, pointIndex) => {
    ctx.beginPath();
    ctx.fillStyle = pointIndex === 0 ? "#fff" : label.color;
    ctx.strokeStyle = label.color;
    ctx.arc(point.x, point.y, POINT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}

function drawCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = elements.canvas.clientWidth;
  const cssHeight = elements.canvas.clientHeight;
  elements.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  elements.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  if (!state.image) {
    return;
  }
  ctx.drawImage(state.image, 0, 0, cssWidth, cssHeight);
  state.contours.forEach((contour) => drawContour(contour, contour.id === state.selectedId));
  drawDraft();
}

function fitCanvas() {
  if (!state.image) {
    return;
  }
  const maxWidth = Math.max(240, elements.stageShell.clientWidth - 36);
  const maxHeight = Math.max(240, elements.stageShell.clientHeight - 36);
  const scale = Math.min(
    maxWidth / state.image.naturalWidth,
    maxHeight / state.image.naturalHeight,
    1.75,
  );
  state.scale = Math.max(0.08, scale);
  elements.canvas.style.width = `${Math.round(state.image.naturalWidth * state.scale)}px`;
  elements.canvas.style.height = `${Math.round(state.image.naturalHeight * state.scale)}px`;
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
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
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
  let minDx = -Infinity;
  let maxDx = Infinity;
  let minDy = -Infinity;
  let maxDy = Infinity;
  contours.forEach((contour) => {
    const bounds = getContourBounds(contour);
    minDx = Math.max(minDx, -bounds.left);
    maxDx = Math.min(maxDx, state.image.naturalWidth - bounds.right);
    minDy = Math.max(minDy, -bounds.top);
    maxDy = Math.min(maxDy, state.image.naturalHeight - bounds.bottom);
  });
  return {
    dx: clamp(dx, minDx, maxDx),
    dy: clamp(dy, minDy, maxDy),
  };
}

function moveContourPoints(points, dx, dy) {
  return points.map((point) => clampPoint({ x: point.x + dx, y: point.y + dy }));
}

function handleDrawPointerDown(point) {
  const firstPoint = state.draftPoints[0];
  if (
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
  const limitedDelta = clampVector(
    point.x - interaction.startPoint.x,
    point.y - interaction.startPoint.y,
    getSoftDragLimit(),
  );
  const rawDx = limitedDelta.dx;
  const rawDy = limitedDelta.dy;
  interaction.wasClamped = limitedDelta.clamped;
  state.contours = interaction.startContours.map((contour) => {
    if (contour.id !== interaction.contourId) {
      return {
        ...contour,
        points: contour.points.map((item) => ({ ...item })),
      };
    }
    const radius = Math.max(1, state.softRadius);
    const anchorOffset = getAnchorOffset(contour, interaction);
    return {
      ...contour,
      points: contour.points.map((item, pointIndex) => {
        const pathDistance = getContourPathDistance(contour, pointIndex, anchorOffset);
        const weight = getSoftWeight(pathDistance, radius);
        if (weight === 0) {
          return { ...item };
        }
        return clampPoint({
          x: item.x + rawDx * weight,
          y: item.y + rawDy * weight,
        });
      }),
    };
  });
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

function normalizeImportedPoint(point) {
  if (Array.isArray(point)) {
    return normalizePoint({ x: point[0], y: point[1] });
  }
  return normalizePoint(point);
}

function isValidImportedPoint(point) {
  if (Array.isArray(point)) {
    return (
      point.length >= 2 &&
      Number.isFinite(Number(point[0])) &&
      Number.isFinite(Number(point[1]))
    );
  }
  return (
    point &&
    Number.isFinite(Number(point.x)) &&
    Number.isFinite(Number(point.y))
  );
}

function normalizeImportedContours(contours) {
  if (!Array.isArray(contours)) {
    throw new Error("Missing contours array.");
  }
  return contours.map((contour) => {
    const closed =
      typeof contour.closed === "boolean"
        ? contour.closed
        : contour.shape_type === "linestrip"
          ? false
          : true;
    if (!Array.isArray(contour.points) || contour.points.length < getMinimumPoints(closed)) {
      throw new Error(`${getShapeName(closed)} does not have enough points.`);
    }
    if (!contour.points.every(isValidImportedPoint)) {
      throw new Error("Contour points must be numeric.");
    }
    return {
      id: typeof contour.id === "string" ? contour.id : createId(),
      label: LABELS.some((label) => label.id === contour.label)
        ? contour.label
        : LABELS[0].id,
      closed,
      points: contour.points.map(normalizeImportedPoint),
    };
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
  elements.finishOpenButton.addEventListener("click", () => finishDraft(false));
  elements.closeShapeButton.addEventListener("click", () => finishDraft(true));
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
