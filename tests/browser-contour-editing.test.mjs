import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { findChrome, delay, waitFor, waitForChildExit, startStaticServer, waitForDevTools, CdpClient } from "./helpers/browser-harness.mjs";
import * as editing from "../src/contour-editing.js";

const profile = mkdtempSync(join(tmpdir(), "face-contour-editing-test-"));
assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep));
const server = await startStaticServer();
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = spawn(findChrome(), ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-background-networking", `--user-data-dir=${profile}`, "--remote-debugging-port=0", url], { stdio: ["ignore", "ignore", "pipe"] });
let client;
try {
  const endpoint = new URL(await waitForDevTools(browser));
  const target = await waitFor(async () => (await (await fetch(`http://${endpoint.host}/json/list`)).json()).find((item) => item.type === "page"), "browser page");
  client = await CdpClient.connect(target.webSocketDebuggerUrl);
  await client.send("Page.enable"); await client.send("Runtime.enable");
  await client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await waitFor(() => client.evaluate('document.querySelector("#hubStatusText")?.textContent.includes("Choose a project")'), "hub");
  const click = (selector) => client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const saved = () => client.evaluate('!document.querySelector("#annotationWorkspaceView").hidden && document.querySelector("#projectSaveState").dataset.state === "saved" && !document.querySelector("#exitProjectButton").disabled');
  const read = () => client.evaluate('(() => { const p = JSON.parse(document.querySelector("#jsonOutput").value); return p.images ? p.images[0] : p; })()');
  const current = async (index) => {
    const c = (await read()).contours[index];
    return { id: c.id, label: c.label, closed: c.closed, points: c.curve.anchors, segments: c.curve.segments };
  };
  const persistedContour = async ({ provider, index }) => client.evaluate(`(async () => {
    if (${JSON.stringify(provider)} === "folder") {
      const root = await navigator.storage.getDirectory();
      const output = await root.getDirectoryHandle("output");
      const dir = await output.getDirectoryHandle("annotations");
      const data = JSON.parse(await (await (await dir.getFileHandle("a.jpg.json")).getFile()).text());
      const c = data.contours[${index}];
      return {id:c.id, label:c.label, closed:c.closed, points:c.curve.anchors, segments:c.curve.segments};
    }
    const storage = await import("/src/storage.js?v=workspace-ux-2");
    const {parseAppRoute} = await import("/src/routes.js?v=workspace-ux-2");
    const {materializeContour} = await import("/src/contour-editing.js?v=workspace-ux-2");
    const project = await storage.getLocalProject(parseAppRoute(location.hash).localProjectKey);
    const [record] = await storage.getLocalProjectImageRecords(project.localProjectKey, [project.currentImageId]);
    const c = materializeContour(record.contours[${index}]);
    return {id:c.id, label:c.label, closed:c.closed, points:c.points, segments:c.segments};
  })()`);
  const select = (index) => client.evaluate(`document.querySelectorAll(".contour-item")[${index}].click()`);
  const input = async ({ from, to = from, shift = false, button = "left", clicks = 1 }) => {
    const rect = await client.evaluate('(() => {const r=document.querySelector("#annotationCanvas").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()');
    const p = (point) => ({ x: rect.x + point.x * rect.width / 512, y: rect.y + point.y * rect.height / 512 });
    const a = p(from), b = p(to);
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...a });
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", ...a, button, buttons: button === "left" ? 1 : 2, clickCount: clicks, modifiers: shift ? 8 : 0 });
    if (from !== to) await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...b, button, buttons: button === "left" ? 1 : 2, modifiers: shift ? 8 : 0 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...b, button, buttons: 0, clickCount: clicks });
  };
  const onCurve = ({ contour, index, t }) => editing.splitSegment({ segment: editing.curveSegments(contour)[index], t })[0].end;
  const screenshot = async (name) => {
    if (!process.env.CONTOUR_QA_DIR) return;
    const { data } = await client.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(process.env.CONTOUR_QA_DIR, `contour-editing-${name}.png`), Buffer.from(data, "base64"));
  };
  for (const provider of ["browser", "folder"]) {
    if (provider === "browser") {
      await client.setFiles("#imageInput", [resolve("samples/face-lena.jpg")]);
    } else {
      const picker = `window.showDirectoryPicker = async ({id}) => (await navigator.storage.getDirectory()).getDirectoryHandle(id === "face-contour-images" ? "images" : "output", {create:true});`;
      await client.send("Page.addScriptToEvaluateOnNewDocument", { source: picker });
      await client.evaluate(picker);
      await client.evaluate(`(async () => {
        const source = await (await navigator.storage.getDirectory()).getDirectoryHandle("images", {create:true});
        const stream = await (await source.getFileHandle("a.jpg", {create:true})).createWritable();
        await stream.write(await (await fetch("/samples/face-lena.jpg")).blob()); await stream.close();
      })()`);
      await click("#openDirectoryButton");
      await waitFor(() => client.evaluate('!document.querySelector("#chooseOutputButton").hidden'), "choose output");
      await click("#chooseOutputButton");
    }
    await waitFor(saved, `${provider} project saved`);
    await click('[data-edit-tool="points"]');
    await select(0);
    assert.equal(await client.evaluate('document.querySelector("#softDragToggle").checked'), false);
    assert.equal(await client.evaluate('document.querySelector("#showPointsToggle").checked'), true);
    const initial = await current(0);

    // Soft editing preserves existing anchor indices for clicks, small motion
    // and real drags. Exercise selection/deletion through the real save paths.
    const originalRadius = await client.evaluate('document.querySelector("#softRadiusInput").value');
    await click("#softDragToggle");
    await client.evaluate('document.querySelector("#softRadiusInput").value = "20"; document.querySelector("#softRadiusInput").dispatchEvent(new Event("input", {bubbles:true}))');
    await waitFor(saved, "soft selection preferences saved");
    const selectionScale = await client.evaluate('document.querySelector("#annotationCanvas").getBoundingClientRect().width / 512');
    for (const { contourIndex, pointIndex, jitter } of [
      { contourIndex: 0, pointIndex: 2, jitter: 0 },
      { contourIndex: 0, pointIndex: 2, jitter: 1 },
      { contourIndex: 0, pointIndex: 4, jitter: 0 },
      { contourIndex: 2, pointIndex: 8, jitter: 1 },
    ]) {
      await select(contourIndex);
      const before = await current(contourIndex);
      const from = before.points[pointIndex];
      await input({ from, ...(jitter ? { to: { x: from.x + jitter / selectionScale, y: from.y } } : {}) });
      assert.deepEqual(await current(contourIndex), before, "A click or sub-threshold movement must not edit geometry");
      await click("#deletePointButton");
      assert.equal(await client.evaluate('document.querySelector("#deletePreviewActions").hidden'), false);
      assert.deepEqual(await current(contourIndex), before, "Deletion preview must not alter the existing anchors");
      assert.deepEqual(await persistedContour({ provider, index: contourIndex }), before);
      await click("#cancelDeleteButton");
      assert.deepEqual(await current(contourIndex), before);
      assert.deepEqual(await persistedContour({ provider, index: contourIndex }), before);
      // Keyboard and button deletion must use the same selected anchor.
      await client.evaluate('document.querySelector("#annotationCanvas").focus()');
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
      assert.equal(await client.evaluate('document.querySelector("#deletePreviewActions").hidden'), false);
      await click("#applyDeleteButton"); await waitFor(saved, "soft click deletion saved");
      const after = await current(contourIndex);
      assert.deepEqual(after.points, before.points.filter((_, index) => index !== pointIndex),
        `${provider}: soft click must delete only the selected anchor ${pointIndex}`);
      assert.deepEqual(await persistedContour({ provider, index: contourIndex }), after);
      await click("#undoButton"); await waitFor(saved, "soft click deletion undone");
      assert.deepEqual(await current(contourIndex), before);
      assert.deepEqual(await persistedContour({ provider, index: contourIndex }), before);
    }

    // A real soft drag keeps the anchor count and selection index. Delete
    // immediately, without clicking the moved point again.
    await select(0);
    const dragFrom = initial.points[2];
    const dragTo = { x: dragFrom.x + 4 / selectionScale, y: dragFrom.y + 6 / selectionScale };
    await input({ from: dragFrom, to: dragTo });
    await waitFor(saved, "soft drag selection saved");
    const softMoved = await current(0);
    const movedIndex = softMoved.points.findIndex((p) => Math.hypot(p.x - dragTo.x, p.y - dragTo.y) < 0.1);
    assert.equal(movedIndex, 2, "Soft dragging must preserve the grabbed anchor's index");
    assert.equal(softMoved.points.length, initial.points.length, "Soft dragging must not add boundary points");
    assert.equal(softMoved.segments.length, initial.segments.length);
    assert.deepEqual(await persistedContour({ provider, index: 0 }), softMoved);
    await click("#deletePointButton");
    if (!await client.evaluate('document.querySelector("#deletePreviewActions").hidden')) await click("#applyDeleteButton");
    await waitFor(saved, "soft moved point deletion saved");
    const softDeleted = await current(0);
    assert.deepEqual(softDeleted.points, softMoved.points.filter((_, index) => index !== movedIndex));
    assert.deepEqual(await persistedContour({ provider, index: 0 }), softDeleted);
    await click("#undoButton"); await waitFor(saved, "soft moved deletion undone");
    assert.deepEqual(await current(0), softMoved);
    await click("#undoButton"); await waitFor(saved, "soft drag undone");
    assert.deepEqual(await current(0), initial);
    assert.deepEqual(await persistedContour({ provider, index: 0 }), initial);
    await click("#redoButton"); await waitFor(saved, "soft drag redone");
    assert.deepEqual(await current(0), softMoved);
    assert.deepEqual(await persistedContour({ provider, index: 0 }), softMoved);
    await click("#undoButton"); await waitFor(saved, "soft drag restored");
    assert.deepEqual(await current(0), initial);
    await click("#softDragToggle");
    await client.evaluate(`document.querySelector("#softRadiusInput").value = ${JSON.stringify(originalRadius)}; document.querySelector("#softRadiusInput").dispatchEvent(new Event("input", {bubbles:true}))`);
    await waitFor(saved, "direct edit preferences restored");
    console.log(`${provider}: soft click, sub-threshold motion, endpoint/closed selection, deletion/cancel/undo and persisted targets passed`);

    const point = initial.points[1];
    await input({ from: point, to: { x: point.x + 14, y: point.y + 12 } });
    await waitFor(saved, "point drag saved");
    const moved = await current(0);
    assert.ok(Math.abs(moved.points[1].x - point.x - 14) < 1, JSON.stringify({ provider, before: point, after: moved.points[1] }));
    await click("#undoButton"); await waitFor(saved, "undo saved");
    assert.deepEqual(await current(0), initial);
    await click("#redoButton"); await waitFor(saved, "redo saved");
    assert.deepEqual(await current(0), moved);

    const mid = onCurve({ contour: moved, index: 2, t: 0.5 });
    await input({ from: mid });
    assert.deepEqual(await current(0), moved, "Ordinary click must only select");
    await input({ from: mid, clicks: 2 });
    await waitFor(saved, "point insertion saved");
    assert.equal((await current(0)).points.length, moved.points.length + 1);
    await click("#deletePointButton"); await waitFor(saved, "point deletion saved");
    assert.equal((await current(0)).points.length, moved.points.length);
    await click("#undoButton"); await waitFor(saved, "restore inserted point");
    await click("#undoButton"); await waitFor(saved, "restore original cubic");
    assert.deepEqual(await current(0), moved);
    await click("#addPointButton");
    await input({ from: mid }); await waitFor(saved, "keyboard test insertion");
    assert.equal(await client.evaluate('document.querySelector("#addPointButton").getAttribute("aria-pressed")'), "false");
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await waitFor(saved, "keyboard point delete saved");
    assert.equal((await current(0)).points.length, moved.points.length);
    assert.equal((await read()).contours.length, 9, "Delete key on a selected point must not delete its contour");
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, autoRepeat: true });
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    assert.equal((await read()).contours.length, 9, "Repeated Delete cannot escalate to deleting contours");
    await click("#undoButton"); await waitFor(saved, "undo keyboard deletion");
    await click("#undoButton"); await waitFor(saved, "undo keyboard insertion");

    await input({ from: moved.points[1] });
    await click("#deletePointButton");
    assert.equal(await client.evaluate('document.querySelector("#deletePreviewActions").hidden'), false);
    assert.deepEqual(await current(0), moved, "Deletion preview must not alter saved data");
    assert.equal(await client.evaluate('document.querySelector("#markDoneButton").disabled'), true);
    await click("#cancelDeleteButton");
    assert.deepEqual(await current(0), moved);
    await click("#deletePointButton");
    await click("#applyDeleteButton"); await waitFor(saved, "fitted deletion saved");
    assert.equal((await current(0)).points.length, moved.points.length - 1);
    await click("#undoButton"); await waitFor(saved, "fitted deletion undone");
    assert.deepEqual(await current(0), moved);

    // Choosing, cancelling, or typing must never be an implicit geometry edit.
    await input({ from: moved.points[1] });
    await input({ from: moved.points[1], clicks: 2 });
    assert.deepEqual(await current(0), moved, "Double-clicking an existing point cannot add another");
    await click("#addPointButton");
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    assert.equal(await client.evaluate('document.querySelector("#addPointButton").getAttribute("aria-pressed")'), "false");
    assert.deepEqual(await current(0), moved);
    await client.evaluate('document.querySelector("#selectedContourLabel").focus()');
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    assert.equal(await client.evaluate('document.querySelector("#deletePreviewActions").hidden'), true);
    assert.deepEqual(await current(0), moved, "Delete within an input must not edit the contour");
    await input({ from: moved.points[1] });
    await click("#deletePointButton");
    await client.evaluate('window.__confirmCalls = 0; window.confirm = () => { window.__confirmCalls++; return false; }');
    // Dispatch exercises the handler guard even though the object button is disabled.
    await client.evaluate('document.querySelectorAll(".contour-item")[1].dispatchEvent(new MouseEvent("click", {bubbles:true}))');
    assert.equal(await client.evaluate('document.querySelector("#deletePreviewActions").hidden'), false);
    await click("#exitProjectButton");
    await waitFor(() => client.evaluate('!document.querySelector("#exitProjectButton").disabled'), "cancel deletion-preview exit");
    assert.equal(await client.evaluate('document.querySelector("#annotationWorkspaceView").hidden'), false);
    assert.deepEqual(await current(0), moved);
    assert.equal(await client.evaluate('window.__confirmCalls'), 2, "Object switch and exit each ask once; no false save-failure prompt");
    await click("#cancelDeleteButton");
    await client.evaluate('window.confirm = () => true');

    await click('[data-edit-tool="transform"]');
    const scale = await client.evaluate('document.querySelector("#annotationCanvas").getBoundingClientRect().width / 512');
    let handles = editing.transformHandles({ contour: moved, scale });
    const corner = handles.handles.find((h) => h.name === "se");
    await input({ from: corner.point, to: { x: corner.point.x + 14, y: corner.point.y + 10 }, shift: true });
    await waitFor(saved, "resize saved");
    const resized = await current(0);
    assert.notDeepEqual(resized.points, moved.points);
    handles = editing.transformHandles({ contour: resized, scale });
    const rotation = handles.handles.at(-1);
    await input({ from: rotation.point, to: { x: rotation.point.x + 22, y: rotation.point.y + 10 } });
    await waitFor(saved, "rotation saved");
    assert.notDeepEqual((await current(0)).segments, resized.segments);
    await screenshot(`${provider}-transform`);

    // Closed-curve preview and alternate arc are exercised with real canvas clicks.
    const closedIndex = (await read()).contours.findIndex((c) => c.closed);
    await select(closedIndex);
    const closed = await current(closedIndex);
    await click('[data-edit-tool="redraw"]');
    const start = onCurve({ contour: closed, index: 0, t: 0.4 });
    const end = onCurve({ contour: closed, index: 5, t: 0.6 });
    await input({ from: start });
    await input({ from: { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 24 } });
    await input({ from: end });
    assert.equal(await client.evaluate('document.querySelector("#applyRedrawButton").disabled'), false);
    assert.deepEqual(await current(closedIndex), closed, "Preview never mutates committed work");
    const pendingStatus = (await read()).status;
    for (const selector of ["#markDoneButton", "#skipImageButton", "#needsReviewButton"]) {
      assert.equal(await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).disabled`), true);
      await click(selector);
    }
    assert.equal((await read()).status, pendingStatus, "Unapplied previews cannot mark the old curve done");
    await click("#alternateRedrawButton");
    await screenshot(`${provider}-redraw`);
    await click("#applyRedrawButton"); await waitFor(saved, "redraw saved");
    const redrawn = await current(closedIndex);
    assert.notDeepEqual(redrawn, closed);
    await click("#undoButton"); await waitFor(saved, "redraw undo saved");
    assert.deepEqual(await current(closedIndex), closed);
    await click("#redoButton"); await waitFor(saved, "redraw redo saved");
    assert.deepEqual(await current(closedIndex), redrawn);

    // Cancelled exit must preserve the draft and must not trigger a second prompt.
    const nextStart = onCurve({ contour: redrawn, index: 1, t: 0.4 });
    await input({ from: nextStart });
    await client.evaluate('window.__confirmCalls = 0; window.confirm = () => { window.__confirmCalls++; return false; }');
    await click("#exitProjectButton");
    await waitFor(() => client.evaluate('!document.querySelector("#exitProjectButton").disabled'), "cancelled exit settles");
    assert.equal(await client.evaluate('window.__confirmCalls'), 1);
    assert.equal(await client.evaluate('document.querySelector("#redrawActions").hidden'), false);
    await click("#cancelRedrawButton"); await waitFor(saved, "preview cancelled");
    await click('[data-edit-tool="points"]');
    await click("#softDragToggle");
    for (let step = 0; step < 3; step += 1) {
      const before = await current(closedIndex);
      await input({ from: before.points[1], to: { x: before.points[1].x + 8, y: before.points[1].y + 3 } });
      await waitFor(saved, "repeated soft edit saved");
      const after = await current(closedIndex);
      assert.notDeepEqual(after.points[1], before.points[1]);
      assert.equal(after.points.length, redrawn.points.length, "Repeated soft edits cannot accumulate anchors");
      assert.equal(after.segments.length, redrawn.segments.length);
      assert.deepEqual(await persistedContour({ provider, index: closedIndex }), after);
    }
    const final = await read();
    const key = await client.evaluate('window.location.hash');
    await click("#exitProjectButton");
    await waitFor(() => client.evaluate('!document.querySelector("#projectHubView").hidden'), "exit hub");
    await client.evaluate(`window.location.hash = ${JSON.stringify(key)}`);
    await waitFor(saved, "reopen from persistent provider");
    assert.deepEqual((await read()).contours, final.contours);
    await client.evaluate('document.documentElement.dataset.beforeTestReload = "true"');
    await client.send("Page.reload");
    await waitFor(() => client.evaluate('document.readyState === "complete" && !document.documentElement.dataset.beforeTestReload'), "new reload document");
    await waitFor(saved, "reload saved geometry");
    assert.deepEqual((await read()).contours, final.contours);
    if (provider === "folder") {
      const disk = await client.evaluate(`(async () => { const root = await navigator.storage.getDirectory(); const output = await root.getDirectoryHandle("output"); const dir = await output.getDirectoryHandle("annotations"); return JSON.parse(await (await (await dir.getFileHandle("a.jpg.json")).getFile()).text()); })()`);
      assert.deepEqual(disk.contours, final.contours);
    }
    // Reject complex historical input in the real import coordinator, before
    // replacing a browser image record or writing a folder sidecar.
    await client.evaluate(`(() => {
      const payload = JSON.parse(document.querySelector("#jsonOutput").value);
      const large = {id:"complex", label:"nose", closed:false, points:Array.from({length:20000}, (_, i) => ({x:50+(i*197)%400, y:50+(i*89)%400}))};
      if (payload.images) { payload.schemaVersion = 1; payload.images[0].contours = [large]; }
      else { payload.version = 1; payload.contours = [large]; }
      const transfer = new DataTransfer();
      transfer.items.add(new File([JSON.stringify(payload)], "complex.json", {type:"application/json"}));
      const input = document.querySelector("#annotationFileInput"); input.files = transfer.files;
      input.dispatchEvent(new Event("change", {bubbles:true}));
    })()`);
    await waitFor(() => client.evaluate('document.querySelector("#statusText").textContent.includes("too complex") && !document.querySelector("#exitProjectButton").disabled'), "complex import rejected");
    assert.deepEqual((await read()).contours, final.contours);
    await click("#zoomInButton"); await click("#zoomInButton");
    await waitFor(() => client.evaluate('document.querySelector("#stageShell").scrollWidth > document.querySelector("#stageShell").clientWidth'), "zoom enables panning");
    const scrollBefore = await client.evaluate('document.querySelector("#stageShell").scrollLeft');
    await input({ from: { x: 240, y: 230 }, to: { x: 190, y: 230 }, button: "right" });
    assert.ok(await client.evaluate('document.querySelector("#stageShell").scrollLeft') > scrollBefore);
    assert.deepEqual((await read()).contours, final.contours, "Right drag pans without editing annotations");
    await click("#zoomFitButton"); await waitFor(saved, "viewport preferences saved");
    await client.send("Emulation.setDeviceMetricsOverride", { width: 980, height: 850, deviceScaleFactor: 1, mobile: false });
    await screenshot(`${provider}-narrow`);
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await click("#exitProjectButton");
    await waitFor(() => client.evaluate('!document.querySelector("#projectHubView").hidden'), "exit final");
    console.log(`${provider}: points, transforms, redraw, undo/redo, preview cancellation, soft edit, exit/reopen and reload passed`);
  }
  assert.deepEqual(client.events.filter((e) => e.method === "Runtime.exceptionThrown"), []);
} finally {
  if (client) {
    try { await Promise.race([client.send("Browser.close"), delay(3000)]); }
    catch (error) { console.warn("Test browser close failed", error); }
  }
  if (!await waitForChildExit(browser, 5000)) { browser.kill(); await waitForChildExit(browser, 5000); }
  await new Promise((resolveClose) => server.close(resolveClose));
  try { rmSync(profile, { recursive: true, force: true }); }
  catch (error) { console.warn("Test profile cleanup failed", { profile, message: error.message }); }
}
