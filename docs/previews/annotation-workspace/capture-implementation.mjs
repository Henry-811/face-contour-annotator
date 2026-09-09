// Isolated production UI verification using only the approved preview image/curves.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, waitFor, waitForDevTools, waitForChildExit, startStaticServer, CdpClient } from '../../../tests/helpers/browser-harness.mjs';
import { insertCurvePoint, curveSegments } from '../../../src/contour-editing.js';
import { serializeContours } from '../../../src/exporter.js';
import { LABELS } from '../../../src/config.js';

const output = dirname(fileURLToPath(import.meta.url));
const fixtureText = readFileSync(join(output, 'preview.js'), 'utf8').match(/const DEMO_CONTOURS = (\[[\s\S]*?\n\]);/)[1];
// This is our checked-in illustrative fixture, not a user annotation/script.
const fixtures = Function(`return (${fixtureText})`)();
const contours = fixtures.map((fixture) => {
  const commands = [...fixture.path.matchAll(/([MC])([\d\s.,-]+)/g)];
  const start = commands[0][2].trim().split(/[\s,]+/).map(Number);
  let contour = { id: fixture.id, label: fixture.name.replaceAll(' ', '_'), closed: fixture.closed, points: [{ x: start[0], y: start[1] }], segments: [] };
  commands.slice(1).forEach((command) => {
    const values = command[2].trim().split(/[\s,]+/).map(Number);
    contour.segments.push({ control1: { x: values[0], y: values[1] }, control2: { x: values[2], y: values[3] } });
    contour.points.push({ x: values[4], y: values[5] });
  });
  if (contour.closed) {
    const first = contour.points[0], last = contour.points.at(-1);
    if (first.x === last.x && first.y === last.y) contour.points.pop();
    else contour.segments.push({ control1: { ...last }, control2: { ...first } });
  }
  while (contour.points.length < fixture.count) {
    const segments = curveSegments(contour);
    const index = segments.map((s, i) => ({ i, length: Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) })).sort((a, b) => b.length - a.length)[0].i;
    contour = insertCurvePoint({ contour, segmentIndex: index, segmentT: .5 }).contour;
  }
  return contour;
});
const profile = mkdtempSync(join(tmpdir(), 'annotation-workspace-qa-'));
const server = await startStaticServer();
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = spawn(findChrome(), ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${profile}`, '--remote-debugging-port=0', url], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let client;
try {
  const endpoint = new URL(await waitForDevTools(browser));
  const target = await waitFor(async () => (await (await fetch(`http://${endpoint.host}/json/list`)).json()).find((item) => item.type === 'page'), 'isolated QA browser');
  client = await CdpClient.connect(target.webSocketDebuggerUrl);
  await client.send('Page.enable'); await client.send('Runtime.enable');
  const click = (selector) => client.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.focus(); element.click(); })()`);
  const saved = () => client.evaluate('!document.querySelector("#annotationWorkspaceView").hidden && document.querySelector("#projectSaveState").dataset.state === "saved" && !document.querySelector("#exitProjectButton").disabled');
  await waitFor(() => client.evaluate('document.querySelector("#hubStatusText")?.textContent.includes("Choose a project")'), 'hub ready');
  await client.setFiles('#imageInput', [join(output, 'portrait.png')]);
  await waitFor(saved, 'real browser project created');
  const payload = await client.evaluate('JSON.parse(document.querySelector("#jsonOutput").value)');
  payload.images[0].contours = serializeContours(contours, LABELS);
  const fixturePath = join(profile, 'visual-fixture.json');
  writeFileSync(fixturePath, JSON.stringify(payload));
  await client.evaluate('window.confirm = () => true');
  await client.setFiles('#annotationFileInput', [fixturePath]);
  await waitFor(() => client.evaluate('JSON.parse(document.querySelector("#jsonOutput").value).images[0].contours.some(contour => contour.id === "right-eye")'), 'real annotation import');
  await waitFor(saved, 'import saved');
  await click('[data-edit-tool="points"]');
  await client.evaluate('document.querySelectorAll(".contour-item")[3].click()');
  for (const { width, height } of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 980, height: 850 }, { width: 800, height: 700 }, { width: 390, height: 844 }]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await click('#zoomFitButton');
    await waitFor(saved, 'viewport preference saved');
    await client.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const anchor = contours[3].points[6];
    const position = await client.evaluate(`(() => { const r = document.querySelector('#annotationCanvas').getBoundingClientRect(); return { x:r.x + ${anchor.x} * r.width/1024, y:r.y + ${anchor.y} * r.height/1024 }; })()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', buttons: 1, clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', buttons: 0, clickCount: 1 });
    const measure = await client.evaluate(`(() => {
      const selectors = ['.project-bar', '.tool-bar', '.context-bar', '.task-bar', '#initializeTemplateButton', '#undoButton', '#redoButton', '#nextImageButton', '#markDoneButton'];
      return { viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        boxes: selectors.map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { selector, x:r.x, y:r.y, width:r.width, right:r.right, bottom:r.bottom }; }),
        toolsOverflow: document.querySelector('.tool-bar').scrollWidth > document.querySelector('.tool-bar').clientWidth,
        toolChildrenFit: [...document.querySelectorAll('.tool-bar button')].filter(button => button.getClientRects().length).every(button => button.getBoundingClientRect().bottom <= document.querySelector('.context-bar').getBoundingClientRect().top + 1) };
    })()`);
    assert.equal(measure.scrollWidth, width); assert.equal(measure.scrollHeight, height); assert.equal(measure.toolsOverflow, false);
    assert.equal(measure.toolChildrenFit, true, 'Wrapped tools must not overlap the context row');
    for (const box of measure.boxes) assert.ok(box.width > 0 && box.x >= 0 && box.y >= 0 && box.right <= width + 1 && box.bottom <= height + 1, JSON.stringify(box));
    const { data } = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(output, `implementation-${width}.png`), Buffer.from(data, 'base64'));
    console.log(JSON.stringify(measure));
  }
  await click('#inspectorToggle');
  assert.equal(await client.evaluate('getComputedStyle(document.querySelector("#contourInspector")).display'), 'flex');
  assert.equal(await client.evaluate('(() => {const drawer=document.querySelector("#contourInspector").getBoundingClientRect(); const editor=document.querySelector(".editor-layout").getBoundingClientRect(); return drawer.top >= editor.top && drawer.bottom <= editor.bottom;})()'), true, 'Drawer must not cover the header or task bar');
  const drawerCapture = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(output, 'implementation-390-inspector.png'), Buffer.from(drawerCapture.data, 'base64'));
  await click('#closeInspector');
  assert.equal(await client.evaluate('document.activeElement.id'), 'inspectorToggle');
  await click('#fileMenu > summary');
  assert.equal(await client.evaluate('document.querySelector("#fileMenu").open'), true);
  const fileBounds = await client.evaluate('(() => {const r=document.querySelector(".file-panel").getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()');
  assert.ok(fileBounds.left >= 0 && fileBounds.right <= 390, `File menu must fit: ${JSON.stringify(fileBounds)}`);
  const fileCapture = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(output, 'implementation-390-file.png'), Buffer.from(fileCapture.data, 'base64'));
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  assert.equal(await client.evaluate('document.querySelector("#fileMenu").open'), false);
  assert.equal(await client.evaluate('document.activeElement.parentElement.id'), 'fileMenu');
  assert.equal(client.events.filter((event) => event.method === 'Runtime.exceptionThrown').length, 0);
  // Browser-rendered side-by-side comparison; no image transformation or editing.
  for (const [width, height] of [[1920, 1080], [1366, 768]]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width: width * 2, height, deviceScaleFactor: 1, mobile: false });
    await client.evaluate(`document.body.replaceChildren(); document.body.style.cssText='margin:0;display:flex;overflow:hidden';
      for (const name of ['workspace', 'implementation']) { const img = document.createElement('img'); img.src='/docs/previews/annotation-workspace/' + name + '-${width}.png'; img.style.cssText='width:${width}px;height:${height}px;max-width:none;flex:none'; document.body.append(img); }`);
    await waitFor(() => client.evaluate('[...document.images].every(img => img.complete && img.naturalWidth > 0)'), 'comparison images loaded');
    const { data } = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(output, `comparison-${width}.png`), Buffer.from(data, 'base64'));
    if (width === 1366) {
      await client.evaluate(`document.body.style.display='block'; [...document.images].forEach((img, index) => {img.style.cssText='position:absolute;left:' + (index * 820) + 'px;top:0;width:1366px;height:768px;max-width:none'; img.style.clipPath='inset(0 546px 618px 0)';});`);
      const detail = await client.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1640, height: 150, scale: 1 } });
      writeFileSync(join(output, 'comparison-tools.png'), Buffer.from(detail.data, 'base64'));
    }
  }
  console.log('Production UI screenshots and viewport/menu checks passed. Independent browser project only.');
} finally {
  client?.webSocket.close(); browser.kill(); await waitForChildExit(browser, 5000); server.close();
  console.log(`Disposable QA profile: ${profile}`);
}
