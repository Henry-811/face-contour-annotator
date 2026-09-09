// Isolated visual prototype: no application imports, storage, directory access,
// annotation imports, or writes. Geometry below is illustrative, not user data.
const SVG_NS = 'http://www.w3.org/2000/svg';
const IMAGE_SIDE = 1024;
const DEMO_IMAGE_COUNT = 1915;
const DEMO_CONTOURS = [
  { id: 'left-eyebrow', name: 'left eyebrow', count: 5, color: '#7960bd', closed: false, path: 'M593 298 C625 268 674 268 706 294' },
  { id: 'right-eyebrow', name: 'right eyebrow', count: 5, color: '#ba7626', closed: false, path: 'M414 302 C449 276 490 281 534 308' },
  { id: 'left-eye', name: 'left eye', count: 30, color: '#179e8c', closed: true, path: 'M609 353 C628 330 670 329 693 344 C680 369 634 371 609 353 Z' },
  { id: 'right-eye', name: 'right eye', count: 28, color: '#26a2eb', closed: true, path: 'M441 348 C465 326 509 328 536 351 C514 377 466 376 441 348 Z' },
  { id: 'nose', name: 'nose', count: 6, color: '#d4ab35', closed: false, path: 'M559 360 C554 397 540 427 544 449 C539 473 562 489 587 480 C607 482 626 475 628 463' },
  { id: 'mouth', name: 'mouth', count: 14, color: '#b65985', closed: true, path: 'M491 560 C516 544 545 545 567 549 C596 536 620 546 643 561 C612 587 553 593 518 575 Z' },
  { id: 'mouth-seam', name: 'mouth seam', count: 7, color: '#eb83b0', closed: false, path: 'M502 563 C541 568 592 558 634 561' },
  { id: 'left-ear', name: 'left ear', count: 18, color: '#57ad64', closed: true, path: 'M744 324 C775 289 792 305 782 346 C781 383 769 416 747 431 C725 430 727 406 732 380 Z' },
  { id: 'right-ear', name: 'right ear', count: 18, color: '#b99849', closed: true, path: 'M287 314 C264 293 253 321 264 350 C267 387 284 426 307 434 C326 427 323 401 310 370 Z' },
];
const state = { selectedId: 'right-eye', tool: 'points', zoom: 1, pan: { x: 0, y: 0 }, drag: null, position: 1, error: false, adding: false };
const $ = (id) => document.getElementById(id);
const paths = new Map();
let toastTimer;

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}
function notice(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
}
function currentContour() { return DEMO_CONTOURS.find((contour) => contour.id === state.selectedId); }

for (const contour of DEMO_CONTOURS) {
  const line = svgElement('path', { d: contour.path, stroke: contour.color, class: 'contour-line' });
  const hit = svgElement('path', { d: contour.path, class: 'contour-hit-area' });
  hit.addEventListener('click', () => selectContour(contour.id));
  $('curves').append(line, hit);
  paths.set(contour.id, line);
  const button = document.createElement('button');
  button.className = 'contour-row';
  button.dataset.contourId = contour.id;
  button.setAttribute('aria-pressed', 'false');
  const dot = document.createElement('span');
  dot.className = 'swatch'; dot.style.setProperty('--swatch', contour.color);
  const name = document.createElement('span'); name.textContent = contour.name;
  const count = document.createElement('span'); count.className = 'point-count'; count.textContent = contour.count;
  button.append(dot, name, count);
  button.addEventListener('click', () => selectContour(contour.id));
  $('contourList').append(button);
}

function renderOverlay() {
  const contour = currentContour();
  const path = paths.get(contour.id);
  const imageSize = $('imageFrame').getBoundingClientRect().width;
  const unitsPerPixel = IMAGE_SIDE / Math.max(imageSize, 1);
  for (const [id, element] of paths) element.classList.toggle('is-selected', id === contour.id);
  $('activeHandles').replaceChildren();
  $('transformOverlay').replaceChildren();
  $('curveTag').replaceChildren();
  if (state.tool === 'points' && $('showPoints').checked) {
    const length = path.getTotalLength();
    for (let index = 0; index < contour.count; index += 1) {
      const point = path.getPointAtLength(length * index / (contour.closed ? contour.count : contour.count - 1));
      const anchor = svgElement('circle', { cx: point.x, cy: point.y, r: (index === 6 ? 4.5 : 2.8) * unitsPerPixel, fill: contour.color, stroke: contour.color, class: `anchor-point${index === 6 ? ' is-active' : ''}` });
      $('activeHandles').append(anchor);
    }
  }
  const bounds = path.getBBox();
  if (state.tool === 'transform') {
    const pad = 13 * unitsPerPixel;
    $('transformOverlay').removeAttribute('hidden');
    $('transformOverlay').append(svgElement('rect', { x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + 2 * pad, height: bounds.height + 2 * pad, class: 'transform-box' }));
    for (const x of [bounds.x - pad, bounds.x + bounds.width + pad]) {
      for (const y of [bounds.y - pad, bounds.y + bounds.height + pad]) $('transformOverlay').append(svgElement('rect', { x: x - 3 * unitsPerPixel, y: y - 3 * unitsPerPixel, width: 6 * unitsPerPixel, height: 6 * unitsPerPixel, fill: 'white', stroke: contour.color }));
    }
  } else $('transformOverlay').setAttribute('hidden', '');
  const tagWidth = (contour.name.length * 6.2 + 16) * unitsPerPixel;
  const tagHeight = 22 * unitsPerPixel;
  const tagX = bounds.x + bounds.width / 2 - tagWidth / 2;
  const tagY = bounds.y - 31 * unitsPerPixel;
  $('curveTag').append(svgElement('rect', { x: tagX, y: tagY, width: tagWidth, height: tagHeight, rx: 3 * unitsPerPixel, fill: '#075787' }));
  const text = svgElement('text', { x: tagX + 8 * unitsPerPixel, y: tagY + 15 * unitsPerPixel, fill: 'white', 'font-family': 'Segoe UI, sans-serif', 'font-size': 11 * unitsPerPixel });
  text.textContent = contour.name;
  $('curveTag').append(text);
}

function selectContour(id) {
  if (!DEMO_CONTOURS.some((contour) => contour.id === id)) return;
  state.selectedId = id;
  const contour = currentContour();
  $('selectionName').textContent = contour.name;
  $('selectionSwatch').style.setProperty('--swatch', contour.color);
  $('labelField').replaceChildren(new Option(contour.name, contour.id));
  $('propertyMeta').replaceChildren();
  for (const value of [contour.closed ? 'Closed curve' : 'Open curve', `${contour.count} points`]) {
    const span = document.createElement('span'); span.textContent = value; $('propertyMeta').append(span);
  }
  document.querySelectorAll('[data-contour-id]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.contourId === id)));
  renderOverlay();
}

function setTool(tool) {
  if (!['points', 'transform', 'redraw', 'new'].includes(tool)) return;
  state.tool = tool; state.adding = false;
  $('addPointButton').setAttribute('aria-pressed', 'false');
  document.querySelectorAll('[data-tool]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.tool === tool)));
  for (const [name, id] of Object.entries({ points: 'pointOptions', transform: 'transformOptions', redraw: 'redrawOptions', new: 'newOptions' })) $(id).hidden = name !== tool;
  $('contextHint').textContent = {
    points: 'Double-click line to add · Drag point to move',
    transform: 'Align the whole contour before refining',
    redraw: 'Replace a section · Preview before applying',
    new: 'Choose a label, then draw a new contour',
  }[tool];
  renderOverlay();
}
function fitImage() {
  const box = $('imageViewport').getBoundingClientRect();
  const side = Math.max(1, Math.min(box.width - 48, box.height));
  const frame = $('imageFrame');
  Object.assign(frame.style, { width: `${side}px`, height: `${side}px`, left: `${(box.width - side) / 2 + state.pan.x}px`, top: `${(box.height - side) / 2 + state.pan.y}px`, transform: `scale(${state.zoom})` });
  $('zoomValue').textContent = `${Math.round(state.zoom * 100)}%`;
  renderOverlay();
}
function zoomBy(factor) { state.zoom = Math.min(3, Math.max(.6, state.zoom * factor)); fitImage(); }
function fit() { state.zoom = 1; state.pan = { x: 0, y: 0 }; fitImage(); }
function showSaveError(value) {
  state.error = value;
  $('saveError').hidden = !value;
  $('saveStatusText').textContent = value ? 'Save failed' : 'Saved to folder';
  document.querySelector('[data-status="Done"]').disabled = value;
  requestAnimationFrame(fitImage);
}
function setPosition(value) {
  state.position = Math.min(DEMO_IMAGE_COUNT, Math.max(1, value));
  $('currentPosition').textContent = state.position;
  $('previousButton').disabled = state.position === 1;
  $('nextButton').disabled = state.position === DEMO_IMAGE_COUNT;
  $('taskStatus').textContent = 'Not reviewed';
  notice('Demo navigation only — the same sample image remains visible.');
}

document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
document.querySelectorAll('[data-notice]').forEach((button) => button.addEventListener('click', () => {
  notice(button.dataset.notice);
  button.closest('[popover]')?.hidePopover();
}));
document.querySelectorAll('[data-status]').forEach((button) => button.addEventListener('click', () => {
  $('taskStatus').textContent = `${button.dataset.status} · demo`;
  notice('Preview status only. No annotation has been saved or changed.');
}));
document.querySelectorAll('[data-position]').forEach((button) => button.addEventListener('click', () => { setPosition(Number(button.dataset.position)); $('queuePanel').hidePopover(); }));
$('initializeButton').addEventListener('click', () => { setTool('points'); selectContour('right-eye'); fit(); notice('Initialize stays one click away. These illustrative contours do not replace your annotations.'); });
$('addPointButton').addEventListener('click', () => { state.adding = !state.adding; $('addPointButton').setAttribute('aria-pressed', String(state.adding)); $('contextHint').textContent = state.adding ? 'Click a curve to place one point · Esc to cancel' : 'Double-click line to add · Drag point to move'; notice('Insertion state preview only — geometry is not edited here.'); });
$('cancelRedraw').addEventListener('click', () => setTool('points'));
$('zoomIn').addEventListener('click', () => zoomBy(1.2));
$('zoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
$('fitButton').addEventListener('click', fit);
$('showPoints').addEventListener('change', renderOverlay);
$('softEdit').addEventListener('change', () => notice('Advanced soft editing is optional, not required for ordinary point adjustments.'));
$('radiusInput').addEventListener('input', (event) => { $('radiusValue').textContent = `${event.target.value} px`; });
$('saveStatus').addEventListener('click', () => showSaveError(!state.error));
$('showErrorButton').addEventListener('click', () => { $('fileMenu').hidePopover(); showSaveError(true); });
$('retryButton').addEventListener('click', () => showSaveError(false));
$('previousButton').addEventListener('click', () => setPosition(state.position - 1));
$('nextButton').addEventListener('click', () => setPosition(state.position + 1));
$('inspectorToggle').addEventListener('click', () => { const open = $('inspector').classList.toggle('is-open'); $('inspectorToggle').setAttribute('aria-expanded', String(open)); });
$('closeInspector').addEventListener('click', () => { $('inspector').classList.remove('is-open'); $('inspectorToggle').setAttribute('aria-expanded', 'false'); $('inspectorToggle').focus(); });
$('imageViewport').addEventListener('contextmenu', (event) => event.preventDefault());
$('imageViewport').addEventListener('wheel', (event) => { event.preventDefault(); zoomBy(event.deltaY < 0 ? 1.08 : 1 / 1.08); }, { passive: false });
$('imageViewport').addEventListener('pointerdown', (event) => {
  if (event.button !== 2) return;
  state.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: { ...state.pan } };
  $('imageViewport').setPointerCapture(event.pointerId);
  $('imageViewport').classList.add('is-panning');
});
$('imageViewport').addEventListener('pointermove', (event) => {
  if (!state.drag || event.pointerId !== state.drag.id) return;
  state.pan = { x: state.drag.pan.x + event.clientX - state.drag.x, y: state.drag.pan.y + event.clientY - state.drag.y };
  fitImage();
});
function endPan() { state.drag = null; $('imageViewport').classList.remove('is-panning'); }
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) $('imageViewport').addEventListener(name, endPan);
window.addEventListener('blur', endPan);
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') { state.adding = false; if (state.tool === 'redraw') setTool('points'); else if (state.tool === 'points') setTool('points'); } });
$('portrait').addEventListener('error', () => notice('The sample image could not be loaded. Keep portrait.png beside this preview page.'));
new ResizeObserver(fitImage).observe($('imageViewport'));
selectContour(state.selectedId);
fitImage();
