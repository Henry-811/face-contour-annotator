import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, waitFor, waitForDevTools, waitForChildExit, CdpClient } from '../../../tests/helpers/browser-harness.mjs';

const output = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2];
if (!url || new URL(url).hostname !== '127.0.0.1') throw new Error('Pass the loopback-only preview URL.');
const browserPath = findChrome();
assert.ok(browserPath, 'A local Chromium browser is required.');
const profile = mkdtempSync(join(tmpdir(), 'annotation-layout-preview-'));
const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${profile}`, '--remote-debugging-port=0', url], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let client;
try {
  const endpoint = new URL(await waitForDevTools(browser));
  const target = await waitFor(async () => (await (await fetch(`http://${endpoint.host}/json/list`)).json()).find((item) => item.type === 'page'), 'isolated preview browser');
  client = await CdpClient.connect(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await waitFor(() => client.evaluate('document.querySelector("#portrait")?.complete && document.querySelector("#portrait")?.naturalWidth === 1024 && document.querySelectorAll(".contour-row").length === 9'), 'preview image and contours');
  for (const { width, height } of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await client.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const measure = await client.evaluate(`(() => {
      const viewport = { width: innerWidth, height: innerHeight };
      const selectors = ['.project-bar', '.tool-bar', '.context-bar', '.task-bar', '#contourList', '.preview-note'];
      return { viewport, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        boxes: selectors.map(selector => {const r=document.querySelector(selector).getBoundingClientRect();return {selector,x:r.x,y:r.y,right:r.right,bottom:r.bottom}}),
        toolOverflow: document.querySelector('.tool-bar').scrollWidth > document.querySelector('.tool-bar').clientWidth,
        frame: (() => {const r=document.querySelector('#imageFrame').getBoundingClientRect();return {width:r.width,height:r.height}}) };
    })()`);
    assert.equal(measure.scrollWidth, width, 'No horizontal page overflow.');
    assert.equal(measure.scrollHeight, height, 'No vertical page overflow.');
    assert.equal(measure.toolOverflow, false, 'Tools fit on screen.');
    for (const box of measure.boxes) assert.ok(box.x >= 0 && box.y >= 0 && box.right <= width + 1 && box.bottom <= height + 1, `${box.selector} must remain visible at ${width}.`);
    const { data } = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(output, `workspace-${width}.png`), Buffer.from(data, 'base64'));
    console.log(JSON.stringify(measure));
  }
  const click = (selector) => client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await click('[data-contour-id="left-eye"]');
  assert.equal(await client.evaluate('document.querySelector("#selectionName").textContent'), 'left eye');
  await click('[data-tool="transform"]');
  assert.equal(await client.evaluate('document.querySelector("#transformOverlay").hasAttribute("hidden")'), false);
  assert.ok(await client.evaluate('document.querySelectorAll("#transformOverlay rect").length') >= 5);
  await click('[data-tool="new"]');
  assert.equal(await client.evaluate('document.querySelector("#newOptions").hidden'), false);
  await click('[data-tool="points"]');
  await click('#saveStatus');
  assert.equal(await client.evaluate('document.querySelector("#saveError").hidden'), false);
  assert.equal(await client.evaluate('document.querySelector("[data-status=Done]").disabled'), true);
  await click('#retryButton');
  assert.equal(await client.evaluate('document.querySelector("#saveError").hidden'), true);
  await click('#nextButton');
  assert.equal(await client.evaluate('document.querySelector("#currentPosition").textContent'), '2');
  await click('#previousButton');
  await click('#zoomIn');
  assert.equal(await client.evaluate('document.querySelector("#zoomValue").textContent'), '120%');
  await click('#fitButton');
  assert.equal(await client.evaluate('document.querySelector("#zoomValue").textContent'), '100%');
  const errors = client.events.filter((event) => event.method === 'Runtime.exceptionThrown');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('Preview-only interaction checks passed. No production annotation flow was executed.');
} finally {
  client?.webSocket.close();
  browser.kill();
  await waitForChildExit(browser, 5000);
  // Intentionally leave only this disposable profile for non-destructive cleanup.
  console.log(`Disposable preview browser profile: ${profile}`);
}
