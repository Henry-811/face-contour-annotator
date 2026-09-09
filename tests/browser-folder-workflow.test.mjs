import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { findChrome, delay, waitFor, waitForChildExit, startStaticServer, waitForDevTools, CdpClient } from "./helpers/browser-harness.mjs";
import { runFolderFirstWriteScenarios } from "./helpers/folder-first-write-scenarios.mjs";

// Native FileSystemDirectory/FileHandle + native createWritable in Chromium.
// Only the OS folder picker is replaced with handles to disposable OPFS folders.
// Permission denial is injected separately; real OS permission dialogs need manual QA.
const chrome = findChrome();
assert.ok(chrome, "Desktop Chrome/Edge is required for this test.");
const profile = mkdtempSync(join(tmpdir(), "face-contour-folder-test-"));
assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep));
const server = await startStaticServer();
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-background-networking", `--user-data-dir=${profile}`, "--remote-debugging-port=0", url], { stdio: ["ignore", "ignore", "pipe"] });
let client;
try {
  const endpoint = new URL(await waitForDevTools(browser));
  const target = await waitFor(async () => (await (await fetch(`http://${endpoint.host}/json/list`)).json()).find((item) => item.type === "page"), "browser page");
  client = await CdpClient.connect(target.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const pickerScript = `
    window.__imageReads = [];
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function(...args) {
      if (/\\.jpg$/i.test(this.name || "")) window.__imageReads.push({ name: this.name, bytes: this.size });
      return read.apply(this, args);
    };
    window.showDirectoryPicker = async ({ id }) => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle(id === "face-contour-images" ? "images" : "output", { create: true });
    };
  `;
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: pickerScript });
  await client.send("Page.navigate", { url });
  await waitFor(() => client.evaluate('document.querySelector("#hubStatusText")?.textContent.includes("Choose a project")'), "initial hub");
  const recoveryCases = await client.evaluate(`(${runFolderFirstWriteScenarios.toString()})()`);
  assert.equal(recoveryCases.length, 17);
  await client.evaluate('window.__imageReads = []');
  const sourceBytes = await client.evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const source = await root.getDirectoryHandle("images", { create: true });
    const jpg = new Uint8Array(await (await fetch("/samples/face-lena.jpg")).arrayBuffer());
    const count = 103, fileBytes = 20 * 1024 * 1024;
    for (let index = 0; index < count; index += 1) {
      const handle = await source.getFileHandle(String(index + 1).padStart(4, "0") + ".jpg", { create: true });
      const stream = await handle.createWritable();
      await stream.write(jpg);
      await stream.seek(fileBytes - 1);
      await stream.write(new Uint8Array([0]));
      await stream.close();
    }
    return count * fileBytes;
  })()`);
  assert.ok(sourceBytes > 2 * 1024 ** 3);
  const started = Date.now();
  await client.evaluate('document.querySelector("#openDirectoryButton").click()');
  await waitFor(() => client.evaluate('!document.querySelector("#chooseOutputButton").hidden'), "output picker step");
  await client.evaluate('document.querySelector("#chooseOutputButton").click()');
  const saved = () => client.evaluate('!document.querySelector("#annotationWorkspaceView").hidden && document.querySelector("#projectSaveState").dataset.state === "saved" && !document.querySelector("#saveNowButton").disabled');
  const reloadPage = async () => {
    await client.evaluate('document.documentElement.dataset.beforeTestReload = "true"');
    await client.send("Page.reload");
    await waitFor(() => client.evaluate('document.readyState === "complete" && !document.documentElement.dataset.beforeTestReload'), "new document after reload");
  };
  await waitFor(saved, "first image saved to folder", 30000);
  assert.equal(await client.evaluate('document.querySelector("#projectPosition").textContent'), "1 / 103");
  assert.equal(await client.evaluate('document.querySelectorAll(".queue-item").length'), 50);
  assert.equal(await client.evaluate('window.__imageReads.length'), 1, "Only the selected image bytes should be read");
  const readSaved = () => client.evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const output = await root.getDirectoryHandle("output");
    const annotations = await output.getDirectoryHandle("annotations");
    return JSON.parse(await (await (await annotations.getFileHandle("0001.jpg.json")).getFile()).text());
  })()`);
  const first = await readSaved();
  assert.equal(first.contours.length, 9);
  assert.equal(first.source.size, 20 * 1024 * 1024);
  assert.equal(first.source.sha256.length, 64);
  await client.evaluate('document.querySelector("[data-edit-tool=points]").click(); document.querySelector(".contour-item").click()');
  const deletionPoint = await client.evaluate(`(() => {
    const point = JSON.parse(document.querySelector("#jsonOutput").value).contours[0].curve.anchors[1];
    const rect = document.querySelector("#annotationCanvas").getBoundingClientRect();
    return { x: rect.x + point.x * rect.width / 512, y: rect.y + point.y * rect.height / 512 };
  })()`);
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", ...deletionPoint, button: "left", buttons: 1, clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...deletionPoint, button: "left", buttons: 0, clickCount: 1 });
  await client.evaluate('document.querySelector("#deletePointButton").click(); window.__previewPrompts = 0; window.confirm = () => { window.__previewPrompts++; return false; }; document.querySelector("#nextImageButton").click()');
  await waitFor(() => client.evaluate('!document.querySelector("#exitProjectButton").disabled'), "cancelled deletion-preview navigation");
  assert.equal(await client.evaluate('document.querySelector("#projectPosition").textContent'), "1 / 103");
  assert.equal(await client.evaluate('document.querySelector("#deletePreviewActions").hidden'), false);
  assert.equal(await client.evaluate('window.__previewPrompts'), 1);
  assert.deepEqual((await readSaved()).contours, first.contours, "Unapplied deletion must never reach disk during navigation");
  await client.evaluate('document.querySelector("#cancelDeleteButton").click(); window.confirm = () => true');
  await waitFor(saved, "deletion preview cancelled");
  await client.evaluate('document.querySelector("#deleteButton").click(); document.querySelector(".mode-button[data-mode=draw]").click()');
  await client.evaluate(`(() => {
    const canvas = document.querySelector("#annotationCanvas"), r = canvas.getBoundingClientRect();
    for (const offset of [0.3, 0.5]) canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: r.left + r.width * offset, clientY: r.top + r.height * 0.4 }));
  })()`);
  await waitFor(saved, "contours and unfinished drawing saved");
  const edited = await readSaved();
  assert.equal(edited.contours.length, 8);
  assert.equal(edited.draft.points.length, 2);
  // Pause real image reading after the outgoing image's save barrier. Every
  // All editing controls stay frozen until the incoming image commits.
  await client.evaluate(`(() => {
    window.__normalRead = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function(...args) {
      if (this.name === "0002.jpg") {
        await new Promise((resolve) => { window.__releaseImageRead = resolve; });
      }
      return window.__normalRead.apply(this, args);
    };
  })()`);
  await client.evaluate('document.querySelector("#imageQueueDisclosure").open = true; const next = document.querySelectorAll("#imageQueueList button")[1]; next.focus(); next.click()');
  await waitFor(() => client.evaluate('typeof window.__releaseImageRead === "function"'), "paused next image read");
  const duringRead = await client.evaluate(`(() => {
    const before = document.querySelector("#jsonOutput").value;
    const item = document.querySelector(".contour-item");
    const select = document.querySelector("#selectedContourLabel");
    const disabled = [...document.querySelectorAll("#newContourLabel, #selectedContourLabel, #contourList button, #deleteButton")].every((control) => control.disabled);
    document.querySelector("#deleteButton").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    select.value = "face_outline";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.querySelector("#newContourLabel").dispatchEvent(new Event("change", { bubbles: true }));
    return { disabled, unchanged: before === document.querySelector("#jsonOutput").value };
  })()`);
  assert.deepEqual(duringRead, { disabled: true, unchanged: true });
  await client.evaluate('window.__releaseImageRead(); Blob.prototype.arrayBuffer = window.__normalRead');
  await waitFor(() => client.evaluate('document.querySelector("#projectPosition").textContent === "2 / 103" && document.querySelector("#projectSaveState").dataset.state === "saved"'), "next image");
  assert.equal(await client.evaluate('document.querySelector("#imageQueueDisclosure").open'), false);
  assert.equal(await client.evaluate('document.activeElement.parentElement.id'), "imageQueueDisclosure", "Queue navigation restores focus after rebuilding the list");
  assert.equal(await client.evaluate('[...document.querySelectorAll("#newContourLabel, #selectedContourLabel, #contourList button")].every((control) => !control.disabled)'), true, "Editing must be enabled after switching");
  await client.evaluate('document.querySelector("#markDoneButton").click()');
  await waitFor(saved, "second image marked done");
  await client.evaluate(`(() => {
    document.querySelector(".mode-button[data-mode=draw]").click();
    const canvas = document.querySelector("#annotationCanvas"), r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: r.left + r.width * 0.3, clientY: r.top + r.height * 0.4 }));
  })()`);
  await waitFor(saved, "new drawing reopens completed image");
  assert.equal(await client.evaluate('JSON.parse(document.querySelector("#jsonOutput").value).status'), "in_progress");
  await client.evaluate('document.querySelector("#previousImageButton").click()');
  await waitFor(() => client.evaluate('document.querySelector("#projectPosition").textContent === "1 / 103" && document.querySelector("#draftMeta").textContent === "2 draft points" && document.querySelector("#projectSaveState").dataset.state === "saved"'), "draft restored on switch");
  assert.deepEqual((await readSaved()).contours, edited.contours);

  // A failed output write must never allow navigation to discard later edits.
  await client.evaluate(`(() => {
    window.__realWritable = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function(...args) {
      if (this.name === "0001.jpg.json") return Promise.reject(new DOMException("Test disk is full", "QuotaExceededError"));
      return window.__realWritable.apply(this, args);
    };
    document.querySelector("#deleteButton").click();
  })()`);
  await waitFor(() => client.evaluate('document.querySelector("#projectSaveState").dataset.state === "failed"'), "visible disk failure");
  await client.evaluate('document.querySelector("#deleteButton").click(); document.querySelector("#nextImageButton").click()');
  await waitFor(() => client.evaluate('!document.querySelector("#nextImageButton").disabled'), "blocked switch finished");
  assert.equal(await client.evaluate('document.querySelector("#projectPosition").textContent'), "1 / 103");
  assert.equal(await client.evaluate('JSON.parse(document.querySelector("#jsonOutput").value).contours.length'), 6);
  assert.equal((await readSaved()).contours.length, 8, "Failed write must preserve previous file");
  await client.evaluate('FileSystemFileHandle.prototype.createWritable = window.__realWritable; document.querySelector("#saveNowButton").click()');
  await waitFor(saved, "save retry");
  assert.equal((await readSaved()).contours.length, 6);

  const hash = await client.evaluate("location.hash");
  await reloadPage();
  await waitFor(saved, "reload from folder files", 30000);
  assert.equal(await client.evaluate("location.hash"), hash);
  assert.equal(await client.evaluate('JSON.parse(document.querySelector("#jsonOutput").value).contours.length'), 6);
  assert.equal(await client.evaluate('document.querySelector("#draftMeta").textContent'), "2 draft points");
  assert.equal(await client.evaluate('window.__imageReads.length'), 1);

  // Same-origin second writer is rejected by the production lock path.
  const busyCode = await client.evaluate(`(async () => {
    const module = await import("/src/folder-workspace.js");
    const root = await navigator.storage.getDirectory();
    try { await module.openFolderWorkspace({ sourceHandle: await root.getDirectoryHandle("images"), outputHandle: await root.getDirectoryHandle("output") }); }
    catch (error) { return error.code; }
    return "unexpected-success";
  })()`);
  assert.equal(busyCode, "FOLDER_BUSY");
  const unsupported = await client.evaluate(`(async () => {
    const module = await import("/src/folder-workspace.js");
    try { await module.ensureFolderPermission({ handle: { kind: "directory", queryPermission: async () => "prompt" }, mode: "read" }); }
    catch (error) { return error.code; }
  })()`);
  assert.equal(unsupported, "FOLDER_PERMISSION");

  // External changes are detected even when the file's revision was not updated.
  await client.evaluate(`(async () => {
    const root = await navigator.storage.getDirectory(), output = await root.getDirectoryHandle("output");
    const annotations = await output.getDirectoryHandle("annotations"), handle = await annotations.getFileHandle("0001.jpg.json");
    const data = JSON.parse(await (await handle.getFile()).text());
    data.status = "needs_review";
    const stream = await handle.createWritable(); await stream.write(JSON.stringify(data)); await stream.close();
    document.querySelector("#skipImageButton").click();
  })()`);
  await waitFor(() => client.evaluate('document.querySelector("#projectSaveState").dataset.state === "failed"'), "external modification conflict");
  assert.equal(await client.evaluate('document.querySelector("#saveErrorBanner").hidden'), false);
  assert.ok(await client.evaluate('document.querySelector("#saveErrorReason").textContent.length > 0'));
  assert.equal(await client.evaluate('document.querySelector("#retrySaveButton").disabled'), false);
  assert.equal(await client.evaluate('document.querySelector("#backupAnnotationsButton").disabled'), false);
  assert.equal((await readSaved()).status, "needs_review");
  await client.evaluate('window.confirm = () => true; document.querySelector("#exitProjectButton").click()');
  await waitFor(() => client.evaluate('!document.querySelector("#projectHubView").hidden && !document.querySelector("#openDirectoryButton").disabled'), "exit with warning");
  await client.evaluate('document.querySelector(".delete-project-button").click()');
  await waitFor(() => client.evaluate('document.querySelector("#projectLibraryCount").textContent === "0 projects"'), "forget shortcut");
  assert.equal((await readSaved()).status, "needs_review", "Forget must not delete disk files");
  await client.evaluate('document.querySelector("#openDirectoryButton").click()');
  await waitFor(() => client.evaluate('!document.querySelector("#chooseOutputButton").disabled'), "reselect source");
  await client.evaluate('document.querySelector("#chooseOutputButton").click()');
  await waitFor(saved, "recovery without bookmark");
  assert.equal(await client.evaluate('JSON.parse(document.querySelector("#jsonOutput").value).status'), "needs_review");

  // Native read/write boundaries: disjoint roots, wrong inventories, corruption,
  // and changed originals must fail without overwriting annotations.
  await client.evaluate('document.querySelector("#exitProjectButton").click()');
  await waitFor(() => client.evaluate('!document.querySelector("#projectHubView").hidden && !document.querySelector("#openDirectoryButton").disabled'), "closed folder before boundary checks");
  // Browser navigation while the first image is loading must not be replaced
  // by the completed folder opening operation.
  await client.evaluate(`(() => {
    window.__normalRead = Blob.prototype.arrayBuffer;
    window.__releaseImageRead = null;
    Blob.prototype.arrayBuffer = async function(...args) {
      if (this.name === "0001.jpg") {
        await new Promise((resolve) => { window.__releaseImageRead = resolve; });
      }
      return window.__normalRead.apply(this, args);
    };
    document.querySelector(".open-project-button").click();
  })()`);
  await waitFor(() => client.evaluate('typeof window.__releaseImageRead === "function"'), "paused first image read");
  await client.evaluate('location.hash = "#/"');
  await client.evaluate('window.__releaseImageRead(); Blob.prototype.arrayBuffer = window.__normalRead');
  await waitFor(() => client.evaluate('!document.querySelector("#projectHubView").hidden && !document.querySelector("#openDirectoryButton").disabled'), "newer hub navigation honored");
  assert.equal(await client.evaluate('location.hash'), "#/");
  const boundaryResults = await client.evaluate(`(async () => {
    const module = await import("/src/folder-workspace.js");
    const root = await navigator.storage.getDirectory();
    const sourceHandle = await root.getDirectoryHandle("images"), outputHandle = await root.getDirectoryHandle("output");
    const result = {};
    const code = async (options) => {
      try { const workspace = await module.openFolderWorkspace(options); workspace.close(); return "unexpected-success"; }
      catch (error) { return error.code; }
    };
    result.sameRoot = await code({ sourceHandle, outputHandle: sourceHandle });
    result.nestedRoot = await code({ sourceHandle: root, outputHandle });
    const empty = await root.getDirectoryHandle("empty", { create: true });
    result.empty = await code({ sourceHandle: empty, outputHandle });
    const different = await root.getDirectoryHandle("different", { create: true });
    const other = await different.getFileHandle("other.jpg", { create: true });
    const otherStream = await other.createWritable(); await otherStream.write(new Uint8Array([1])); await otherStream.close();
    result.wrongInventory = await code({ sourceHandle: different, outputHandle });
    const annotations = await outputHandle.getDirectoryHandle("annotations");
    const annotation = await annotations.getFileHandle("0001.jpg.json");
    const originalJson = await (await annotation.getFile()).text();
    let stream = await annotation.createWritable(); await stream.write("invalid-json"); await stream.close();
    result.corrupt = await code({ sourceHandle, outputHandle });
    result.corruptKept = await (await annotation.getFile()).text();
    stream = await annotation.createWritable(); await stream.write(originalJson); await stream.close();
    const image = await sourceHandle.getFileHandle("0001.jpg");
    const size = (await image.getFile()).size;
    stream = await image.createWritable({ keepExistingData: true }); await stream.seek(size); await stream.write(new Uint8Array([1])); await stream.close();
    const workspace = await module.openFolderWorkspace({ sourceHandle, outputHandle });
    try { await workspace.loadImage(workspace.project.images[0]); result.changedImage = "unexpected-success"; }
    catch (error) { result.changedImage = error.code; }
    finally { workspace.close(); }
    result.savedFileKept = originalJson === await (await annotation.getFile()).text();
    stream = await image.createWritable({ keepExistingData: true }); await stream.truncate(size); await stream.close();
    return result;
  })()`);
  assert.deepEqual(boundaryResults, {
    sameRoot: "FOLDER_OVERLAP", nestedRoot: "FOLDER_OVERLAP", empty: "FOLDER_EMPTY", wrongInventory: "FOLDER_MISMATCH",
    corrupt: "FOLDER_INVALID_JSON", corruptKept: "invalid-json", changedImage: "FOLDER_SOURCE_CHANGED", savedFileKept: true,
  });
  await client.evaluate('document.querySelector(".open-project-button").click()');
  await waitFor(saved, "reconnect native handles");
  // Restoring the downloaded per-image format follows the real input/coordinator.
  await client.evaluate(`(() => {
    const data = JSON.parse(document.querySelector("#jsonOutput").value);
    // Exercise historical anchor-only input migration with fractional precision.
    data.version = 1;
    data.contours = data.contours.map(({ curve, ...contour }) => ({ ...contour, points: curve.anchors }));
    data.contours[0].points[0] = { x: 10.25, y: 20.75 };
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify(data)], "current.json", { type: "application/json" }));
    const input = document.querySelector("#annotationFileInput");
    input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(() => client.evaluate('document.querySelector("#statusText").textContent.includes("Current image restored and saved")'), "per-image restore");
  assert.deepEqual((await readSaved()).contours[0].points[0], { x: 10.25, y: 20.75 });
  await reloadPage();
  await waitFor(saved, "fractional contour coordinates restored");
  assert.deepEqual(await client.evaluate('JSON.parse(document.querySelector("#jsonOutput").value).contours[0].points[0]'), { x: 10.25, y: 20.75 });

  // Exercise failed first-sidecar creation through the real app, then exit and
  // reopen. A new image's failed save must not block earlier saved annotations.
  const beforeFirstSaveFailure = await readSaved();
  await client.evaluate(`(() => {
    window.__realWritable = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function(...args) {
      if (this.name === "0003.jpg.json") return Promise.reject(new DOMException("First save disk failure", "QuotaExceededError"));
      return window.__realWritable.apply(this, args);
    };
    document.querySelectorAll(".queue-item")[2].click();
  })()`);
  await waitFor(() => client.evaluate('document.querySelector("#projectPosition").textContent === "3 / 103" && document.querySelector("#projectSaveState").dataset.state === "failed"'), "failed first sidecar shown in app");
  const failedSidecarAbsent = await client.evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const annotations = await (await root.getDirectoryHandle("output")).getDirectoryHandle("annotations");
    try { await annotations.getFileHandle("0003.jpg.json"); return false; }
    catch (error) { if (error.name === "NotFoundError") return true; throw error; }
  })()`);
  assert.equal(failedSidecarAbsent, true);
  assert.deepEqual(await readSaved(), beforeFirstSaveFailure, "Earlier disk annotation must remain exact");
  await client.evaluate('FileSystemFileHandle.prototype.createWritable = window.__realWritable; window.confirm = () => true; document.querySelector("#exitProjectButton").click()');
  await waitFor(() => client.evaluate('!document.querySelector("#projectHubView").hidden && !document.querySelector("#openDirectoryButton").disabled'), "exit after failed first save");
  await client.evaluate('document.querySelector(".open-project-button").click()');
  await waitFor(saved, "earlier saved image reopens after failed first sidecar");
  assert.equal(await client.evaluate('document.querySelector("#projectPosition").textContent'), "1 / 103");
  assert.deepEqual((await readSaved()).contours, beforeFirstSaveFailure.contours);
  assert.deepEqual((await readSaved()).draft, beforeFirstSaveFailure.draft);

  // A rejected older save does not mean every queued save has settled. Exiting
  // must retain the workspace lease until a later held write also completes.
  const beforeQueuedFailure = await readSaved();
  await client.evaluate(`(() => {
    window.__realWritable = FileSystemFileHandle.prototype.createWritable;
    window.__originalSetTimeout = window.setTimeout;
    window.__saveTimerCount = 0;
    window.__exitConfirmCount = 0;
    window.setTimeout = function(callback, delay, ...args) {
      return window.__originalSetTimeout(() => {
        callback(...args);
        if (delay === 200) window.__saveTimerCount += 1;
      }, delay);
    };
    let writes = 0;
    FileSystemFileHandle.prototype.createWritable = async function(...args) {
      if (this.name === "0001.jpg.json") {
        writes += 1;
        if (writes === 1) await new Promise((resolve, reject) => { window.__failEarlierSave = reject; });
        if (writes === 2) await new Promise((resolve) => { window.__finishLaterSave = resolve; });
      }
      return window.__realWritable.apply(this, args);
    };
    window.confirm = () => { window.__exitConfirmCount += 1; return true; };
    document.querySelector("#deleteButton").click();
  })()`);
  await waitFor(() => client.evaluate('typeof window.__failEarlierSave === "function"'), "held earlier save");
  await client.evaluate('document.querySelector("#deleteButton").click()');
  await waitFor(() => client.evaluate('window.__saveTimerCount === 2'), "second save queued");
  await client.evaluate('window.setTimeout = window.__originalSetTimeout; window.__failEarlierSave(new DOMException("Earlier save failed", "QuotaExceededError"))');
  await waitFor(() => client.evaluate('typeof window.__finishLaterSave === "function" && document.querySelector("#projectSaveState").dataset.state === "failed"'), "later save still held after earlier failure");
  const exitWhileSaving = await client.evaluate(`(async () => {
    document.querySelector("#exitProjectButton").click();
    await navigator.locks.query();
    return { confirmations: window.__exitConfirmCount, workspaceVisible: !document.querySelector("#annotationWorkspaceView").hidden };
  })()`);
  assert.deepEqual(exitWhileSaving, { confirmations: 0, workspaceVisible: true });
  await client.evaluate('window.__finishLaterSave(); FileSystemFileHandle.prototype.createWritable = window.__realWritable');
  await waitFor(() => client.evaluate('!document.querySelector("#projectHubView").hidden && !document.querySelector("#openDirectoryButton").disabled'), "exit only after held write settled");
  assert.equal((await readSaved()).contours.length, beforeQueuedFailure.contours.length - 2);
  await client.evaluate('document.querySelector(".open-project-button").click()');
  await waitFor(saved, "reopen after queued save failure");

  // Capture real content for visual inspection outside the disposable profile.
  if (process.env.FOLDER_QA_SCREENSHOT) {
    const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.FOLDER_QA_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
    await client.evaluate('document.querySelector("#exitProjectButton").click()');
    await waitFor(() => client.evaluate('!document.querySelector("#projectHubView").hidden'), "hub screenshot");
    const hubScreenshot = await client.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.FOLDER_QA_SCREENSHOT.replace(/\.png$/, "-hub.png"), Buffer.from(hubScreenshot.data, "base64"));
  }
  assert.equal(client.events.some((event) => event.method === "Runtime.exceptionThrown"), false);
  console.log(JSON.stringify({ test: "folder-workflow", sourceBytes, images: 103, firstWriteRecoveryCases: recoveryCases.length, elapsedMs: Date.now() - started, nativeFilesystem: "Chromium OPFS; OS picker substituted" }));
} finally {
  if (client) {
    try { await Promise.race([client.send("Browser.close"), delay(3000)]); }
    catch (error) { console.warn("Browser close failed.", error); }
  }
  if (!await waitForChildExit(browser, 5000)) { browser.kill(); await waitForChildExit(browser, 5000); }
  await new Promise((resolveClose) => server.close(resolveClose));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { rmSync(profile, { recursive: true, force: true }); break; }
    catch (error) {
      if (attempt === 19) console.warn("Disposable profile cleanup failed.", { profile, message: error.message });
      else await delay(100);
    }
  }
}
