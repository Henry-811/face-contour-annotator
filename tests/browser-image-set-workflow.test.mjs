import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const fflate = require("../vendor/fflate-0.8.3.js");
const ZIP_FIXTURE = resolve(WORKSPACE, "tests/fixtures/image-set.zip");
const BROKEN_ZIP_FIXTURE = resolve(WORKSPACE, "tests/fixtures/broken.zip");
const PARTIAL_ANNOTATIONS_FIXTURE = resolve(
  WORKSPACE,
  "tests/fixtures/partial.face-contour-annotations.json",
);
const ROLLBACK_ANNOTATIONS_FIXTURE = resolve(
  WORKSPACE,
  "tests/fixtures/rollback.face-contour-annotations.json",
);
const SOURCE_REPLACEMENT_IMAGE = resolve(WORKSPACE, "samples/face-lena.jpg");
const EXPECTED_PATHS = [
  "faces/2-face-lena.jpg",
  "faces/10-run-asset-type-samples.png",
  "faces/20-large-worker.bmp",
];
const MIME_TYPES = new Map([
  [".bmp", "image/bmp"],
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".zip", "application/zip"],
]);

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.LOCALAPPDATA &&
      join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    process.env.LOCALAPPDATA &&
      join(process.env.LOCALAPPDATA, "Microsoft/Edge/Application/msedge.exe"),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Microsoft/Edge/Application/msedge.exe"),
    process.env["PROGRAMFILES(X86)"] &&
      join(process.env["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  return candidates.find(existsSync) || null;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveExit) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null) {
      child.off("exit", onExit);
      onExit();
    }
  });
}

async function waitFor(check, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${description}.${lastError ? ` Last error: ${lastError.message}` : ""}`,
  );
}

function startStaticServer() {
  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const absolutePath = resolve(WORKSPACE, requestedPath);
      if (absolutePath !== WORKSPACE && !absolutePath.startsWith(`${WORKSPACE}${sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      if (!statSync(absolutePath).isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type":
          MIME_TYPES.get(extname(absolutePath).toLowerCase()) || "application/octet-stream",
      });
      response.end(readFileSync(absolutePath));
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500).end("Request failed");
    }
  });
  return new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function waitForDevTools(browserProcess) {
  return new Promise((resolveTools, rejectTools) => {
    let stderr = "";
    const timer = setTimeout(() => {
      rejectTools(new Error(`Chrome did not expose DevTools. ${stderr.slice(-1000)}`));
    }, 15_000);
    browserProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolveTools(match[1]);
      }
    });
    browserProcess.once("exit", (code) => {
      clearTimeout(timer);
      rejectTools(new Error(`Chrome exited before DevTools was ready (code ${code}).`));
    });
  });
}

class CdpClient {
  constructor(webSocket) {
    this.webSocket = webSocket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    webSocket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        this.events.push(message);
        return;
      }
      if (!this.pending.has(message.id)) {
        return;
      }
      const { resolveCommand, rejectCommand } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        rejectCommand(new Error(message.error.message));
      } else {
        resolveCommand(message.result || {});
      }
    });
  }

  static async connect(url) {
    const webSocket = new WebSocket(url);
    await new Promise((resolveSocket, rejectSocket) => {
      webSocket.addEventListener("open", resolveSocket, { once: true });
      webSocket.addEventListener("error", () => rejectSocket(new Error("CDP connection failed.")), {
        once: true,
      });
    });
    return new CdpClient(webSocket);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, { resolveCommand, rejectCommand });
      this.webSocket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ||
          response.exceptionDetails.text ||
          "Browser evaluation failed.",
      );
    }
    return response.result?.value;
  }

  async setFiles(selector, files) {
    const { root } = await this.send("DOM.getDocument", { depth: 1 });
    const { nodeId } = await this.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    assert.notEqual(nodeId, 0, `${selector} was not found.`);
    await this.send("DOM.setFileInputFiles", { nodeId, files });
    await this.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event("change", { bubbles: true }))`,
    );
  }
}

async function readBusinessState(client) {
  return client.evaluate(`(() => {
    const payload = JSON.parse(document.querySelector("#jsonOutput").value);
    return {
      name: document.querySelector("#projectName").textContent,
      position: document.querySelector("#projectPosition").textContent,
      fileMeta: document.querySelector("#fileMeta").textContent,
      imageSize: document.querySelector("#imageSize").textContent,
      paths: payload.images.map((image) => image.relativePath),
      statuses: payload.images.map((image) => image.status),
      contourCounts: payload.images.map((image) => image.contours.length),
      currentImagePath: payload.imageSet.currentImagePath,
      showPoints: document.querySelector("#showPointsToggle").checked,
    };
  })()`);
}

async function readStoredState(client) {
  return client.evaluate(`(async () => {
    const storage = await import("/src/storage.js?v=browser-image-set-storage-inspection");
    const metadata = await storage.getCurrentProject();
    const records = await storage.getProjectImageRecords(metadata.images.map((image) => image.id));
    return { metadata, records };
  })()`);
}

let reloadSequence = 0;

async function reloadPage(client) {
  reloadSequence += 1;
  const previousDocumentMarker = `before-reload-${reloadSequence}`;
  await client.evaluate(
    `document.documentElement.dataset.e2eReloadMarker = ${JSON.stringify(previousDocumentMarker)}`,
  );
  const eventOffset = client.events.length;
  const reloadUrl = new URL(appUrl);
  reloadUrl.searchParams.set("e2e-reload", String(reloadSequence));
  const navigation = await client.send("Page.navigate", { url: reloadUrl.href });
  if (navigation.errorText) {
    throw new Error(`Page reload navigation failed: ${navigation.errorText}`);
  }
  await waitFor(
    async () => {
      const dialogEvent = client.events
        .slice(eventOffset)
        .find((event) => event.method === "Page.javascriptDialogOpening");
      if (dialogEvent) {
        throw new Error(
          `Unexpected dialog while reloading: ${JSON.stringify(dialogEvent.params)}`,
        );
      }
      return client.evaluate(
        `document.readyState === "complete" && document.documentElement.dataset.e2eReloadMarker !== ${JSON.stringify(previousDocumentMarker)}`,
      );
    },
    "the reloaded document",
    30_000,
  );
}

const chromePath = findChrome();
if (!chromePath || typeof WebSocket !== "function") {
  const reason = !chromePath ? "Chrome/Edge was not found" : "Node WebSocket is unavailable";
  if (process.env.ALLOW_BROWSER_TEST_SKIP === "1") {
    console.log(`browser image-set workflow test skipped (${reason})`);
    process.exit(0);
  }
  throw new Error(
    `${reason}. Set CHROME_BIN, or set ALLOW_BROWSER_TEST_SKIP=1 only when an explicit skip is intended.`,
  );
}

const server = await startStaticServer();
const address = server.address();
const appUrl = `http://127.0.0.1:${address.port}/?browser-image-set-workflow=1`;
const profileDirectory = mkdtempSync(join(tmpdir(), "face-contour-browser-test-"));
const resolvedProfileDirectory = resolve(profileDirectory);
const resolvedTemporaryRoot = resolve(tmpdir());
assert.equal(
  resolvedProfileDirectory.startsWith(`${resolvedTemporaryRoot}${sep}`),
  true,
  "The disposable browser profile must stay inside the system temporary directory.",
);
const downloadDirectory = join(resolvedProfileDirectory, "downloads");
mkdirSync(downloadDirectory);
const boundedWorkerZip = join(resolvedProfileDirectory, "bounded-workers.zip");
const boundedWorkerSource = readFileSync(SOURCE_REPLACEMENT_IMAGE);
writeFileSync(
  boundedWorkerZip,
  fflate.zipSync(
    Object.fromEntries(
      Array.from({ length: 8 }, (_value, index) => [
        `workers/${String(index + 1).padStart(2, "0")}.jpg`,
        boundedWorkerSource,
      ]),
    ),
    { level: 6 },
  ),
);
const browserProcess = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-gpu",
    "--disable-sync",
    "--no-default-browser-check",
    "--no-first-run",
    `--user-data-dir=${profileDirectory}`,
    "--remote-debugging-port=0",
    appUrl,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let client = null;
try {
  const browserWebSocketUrl = await waitForDevTools(browserProcess);
  const browserEndpoint = new URL(browserWebSocketUrl);
  const target = await waitFor(async () => {
    const response = await fetch(`http://${browserEndpoint.host}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.type === "page" && item.url.startsWith(appUrl));
  }, "the application page target");
  client = await CdpClient.connect(target.webSocketDebuggerUrl);
  await Promise.all([
    client.send("DOM.enable"),
    client.send("Page.enable"),
    client.send("Runtime.enable"),
  ]);
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const NativeWorker = window.Worker;
      window.__zipWorkerCount = 0;
      window.__zipWorkerActive = 0;
      window.__zipWorkerPeak = 0;
      function InstrumentedWorker(...args) {
        window.__zipWorkerCount += 1;
        window.__zipWorkerActive += 1;
        window.__zipWorkerPeak = Math.max(
          window.__zipWorkerPeak,
          window.__zipWorkerActive,
        );
        const worker = new NativeWorker(...args);
        const nativeTerminate = worker.terminate.bind(worker);
        let active = true;
        worker.terminate = (...terminateArgs) => {
          if (active) {
            active = false;
            window.__zipWorkerActive -= 1;
          }
          return nativeTerminate(...terminateArgs);
        };
        return worker;
      }
      InstrumentedWorker.prototype = NativeWorker.prototype;
      Object.setPrototypeOf(InstrumentedWorker, NativeWorker);
      window.Worker = InstrumentedWorker;
    })();`,
  });
  await reloadPage(client);
  await waitFor(
    () =>
      client.evaluate(
        'document.readyState === "complete" && Boolean(document.querySelector("#zipInput")) && window.__zipWorkerCount === 0',
      ),
    "the application shell",
  );

  await client.setFiles("#zipInput", [boundedWorkerZip]);
  await waitFor(
    () =>
      client.evaluate(`(() => {
        try {
          const payload = JSON.parse(document.querySelector("#jsonOutput").value);
          return document.querySelector("#projectName").textContent === "bounded-workers" &&
            payload.images.length === 8 &&
            document.querySelector("#projectSaveState").dataset.state === "saved" &&
            window.__zipWorkerActive === 0;
        } catch (error) {
          return false;
        }
      })()`),
    "the bounded ZIP worker fixture",
    45_000,
  );
  const boundedWorkerEvidence = await client.evaluate(`(() => ({
    total: window.__zipWorkerCount,
    peak: window.__zipWorkerPeak,
    active: window.__zipWorkerActive,
  }))()`);
  assert.equal(boundedWorkerEvidence.total, 8);
  assert.equal(boundedWorkerEvidence.peak <= 3, true);
  assert.equal(boundedWorkerEvidence.peak >= 2, true);
  assert.equal(boundedWorkerEvidence.active, 0);
  await client.evaluate(`(() => {
    window.__zipWorkerCount = 0;
    window.__zipWorkerActive = 0;
    window.__zipWorkerPeak = 0;
  })()`);

  await client.setFiles("#zipInput", [ZIP_FIXTURE]);
  await waitFor(
    () =>
      client.evaluate(`(() => {
        try {
          const payload = JSON.parse(document.querySelector("#jsonOutput").value);
          return document.querySelector("#projectName").textContent === "image-set" &&
            document.querySelector("#projectSaveState").dataset.state === "saved" &&
            JSON.stringify(payload.images.map((image) => image.relativePath)) === ${JSON.stringify(JSON.stringify(EXPECTED_PATHS))};
        } catch (error) {
          return false;
        }
      })()`),
    "the real ZIP image set",
    45_000,
  );
  const opened = await readBusinessState(client);
  assert.equal(opened.position, "1 / 3");
  assert.deepEqual(opened.paths, EXPECTED_PATHS);
  assert.equal(await client.evaluate("window.__zipWorkerCount > 0"), true);
  assert.equal(await client.evaluate("window.__zipWorkerPeak <= 3"), true);
  assert.equal(await client.evaluate("window.__zipWorkerActive"), 0);

  const synchronousWriteFailure = await client.evaluate(`(async () => {
    const storage = await import("/src/storage.js?v=image-set-annotations-1");
    let rejected = false;
    try {
      await storage.putProjectImageRecords([
        {
          id: "sync-abort-probe",
          name: "sync-abort-probe.jpg",
          path: "sync-abort-probe.jpg",
          width: 1,
          height: 1,
          status: "unlabeled",
          contours: [],
        },
        {
          id: "sync-abort-trigger",
          name: "sync-abort-trigger.jpg",
          path: "sync-abort-trigger.jpg",
          width: 1,
          height: 1,
          status: "unlabeled",
          contours: [{ id: "invalid", points: null }],
        },
      ]);
    } catch (error) {
      rejected = true;
    }
    return {
      rejected,
      leakedRecord: await storage.getProjectImageRecord("sync-abort-probe"),
    };
  })()`);
  assert.equal(synchronousWriteFailure.rejected, true);
  assert.equal(synchronousWriteFailure.leakedRecord, null);

  const beforeFailedImageSwitch = await readBusinessState(client);
  const storedBeforeFailedImageSwitch = await readStoredState(client);
  await client.evaluate(`(async () => {
    const storage = await import("/src/storage.js?v=image-set-annotations-1");
    const metadata = await storage.getCurrentProject();
    const targetId = metadata.images[2].id;
    window.__e2eOriginalTargetAsset = await storage.getProjectImageAsset(targetId);
    await storage.putProjectImageAsset({
      id: targetId,
      dataUrl: "data:image/jpeg;base64,AA==",
      updatedAt: new Date().toISOString(),
    });
    document.querySelectorAll("#imageQueueList .queue-item")[2].click();
  })()`);
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#statusText").textContent.includes("Image could not be loaded")',
      ),
    "the failed image switch",
  );
  assert.deepEqual(await readBusinessState(client), beforeFailedImageSwitch);
  assert.deepEqual(await readStoredState(client), storedBeforeFailedImageSwitch);
  await client.evaluate(`(() => {
    const payload = JSON.parse(document.querySelector("#jsonOutput").value);
    payload.imageSet.currentImagePath = payload.images[2].relativePath;
    payload.images[2] = {
      ...payload.images[2],
      status: "skipped",
      contours: [],
      updatedAt: new Date().toISOString(),
    };
    const transfer = new DataTransfer();
    transfer.items.add(new File(
      [JSON.stringify(payload)],
      "corrupt-target.face-contour-annotations.json",
      { type: "application/json" },
    ));
    const input = document.querySelector("#annotationFileInput");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#statusText").textContent.includes("Stored source image could not be decoded")',
      ),
    "the corrupt-target annotation import failure",
  );
  assert.deepEqual(await readBusinessState(client), beforeFailedImageSwitch);
  assert.deepEqual(await readStoredState(client), storedBeforeFailedImageSwitch);
  await client.evaluate(`(async () => {
    const storage = await import("/src/storage.js?v=image-set-annotations-1");
    await storage.putProjectImageAsset(window.__e2eOriginalTargetAsset);
    delete window.__e2eOriginalTargetAsset;
  })()`);

  const dimensionMismatchSwitch = await client.evaluate(`(async () => {
    const storage = await import("/src/storage.js?v=image-set-annotations-1");
    const metadata = await storage.getCurrentProject();
    const target = metadata.images[2];
    const originalAsset = await storage.getProjectImageAsset(target.id);
    const canvas = document.createElement("canvas");
    canvas.width = target.width === 32 ? 33 : 32;
    canvas.height = target.height === 32 ? 33 : 32;
    await storage.putProjectImageAsset({
      id: target.id,
      dataUrl: canvas.toDataURL("image/png"),
      updatedAt: new Date().toISOString(),
    });
    document.querySelectorAll("#imageQueueList .queue-item")[2].click();
    return { originalAsset };
  })()`);
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#statusText").textContent.includes("Stored source image dimensions no longer match")',
      ),
    "the dimension-mismatched image switch failure",
  );
  assert.deepEqual(await readBusinessState(client), beforeFailedImageSwitch);
  assert.deepEqual(await readStoredState(client), storedBeforeFailedImageSwitch);
  await client.evaluate(`(async () => {
    const storage = await import("/src/storage.js?v=image-set-annotations-1");
    await storage.putProjectImageAsset(${JSON.stringify(dimensionMismatchSwitch.originalAsset)});
  })()`);

  const dimensionMismatchRestore = await client.evaluate(`(async () => {
    const storage = await import("/src/storage.js?v=image-set-annotations-1");
    const metadata = await storage.getCurrentProject();
    const current = metadata.images.find((image) => image.id === metadata.currentImageId);
    const originalAsset = await storage.getProjectImageAsset(current.id);
    const canvas = document.createElement("canvas");
    canvas.width = current.width === 32 ? 33 : 32;
    canvas.height = current.height === 32 ? 33 : 32;
    await storage.putProjectImageAsset({
      id: current.id,
      dataUrl: canvas.toDataURL("image/png"),
      updatedAt: new Date().toISOString(),
    });
    return { originalAsset };
  })()`);
  await reloadPage(client);
  await waitFor(
    () =>
      client.evaluate(`(() =>
        document.querySelector("#statusText").textContent.includes("Saved image set could not be restored") &&
        document.querySelector("#jsonOutput").value === "No image set is open."
      )()`),
    "the dimension-mismatched refresh failure",
  );
  assert.deepEqual(await readStoredState(client), storedBeforeFailedImageSwitch);
  await client.evaluate(`(async () => {
    const storage = await import("/src/storage.js?v=image-set-annotations-1");
    await storage.putProjectImageAsset(${JSON.stringify(dimensionMismatchRestore.originalAsset)});
  })()`);
  await reloadPage(client);
  await waitFor(
    () =>
      client.evaluate(`(() => {
        try {
          JSON.parse(document.querySelector("#jsonOutput").value);
          return document.querySelector("#projectSaveState").dataset.state === "saved";
        } catch (error) {
          return false;
        }
      })()`),
    "the restored image set after repairing the mismatched asset",
  );
  assert.deepEqual(await readBusinessState(client), beforeFailedImageSwitch);
  assert.deepEqual(await readStoredState(client), storedBeforeFailedImageSwitch);

  const storedBeforeAutosaveFailure = await readStoredState(client);
  await client.evaluate(`(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put");
    window.__e2eAutosavePutDescriptor = descriptor;
    window.__e2eAutosaveFailureCount = 0;
    Object.defineProperty(IDBObjectStore.prototype, "put", {
      ...descriptor,
      value(value, key) {
        if (
          window.__e2eAutosaveFailureCount === 0 &&
          this.name === "project-images" &&
          value?.status === "done"
        ) {
          window.__e2eAutosaveFailureCount += 1;
          throw new Error("Forced production autosave failure.");
        }
        return descriptor.value.call(this, value, key);
      },
    });
    document.querySelector("#markDoneButton").click();
  })()`);
  await waitFor(
    () =>
      client.evaluate(`(() =>
        document.querySelector("#projectSaveState").dataset.state === "failed" &&
        document.querySelector("#statusText").textContent.includes("Local save failed")
      )()`),
    "the production autosave failure",
  );
  const autosaveFailureEvidence = await client.evaluate(`(() => {
    const unloadEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unloadEvent);
    const evidence = {
      failureCount: window.__e2eAutosaveFailureCount,
      unloadPrevented: unloadEvent.defaultPrevented,
    };
    Object.defineProperty(
      IDBObjectStore.prototype,
      "put",
      window.__e2eAutosavePutDescriptor,
    );
    delete window.__e2eAutosavePutDescriptor;
    return evidence;
  })()`);
  assert.deepEqual(autosaveFailureEvidence, {
    failureCount: 1,
    unloadPrevented: true,
  });
  assert.deepEqual(await readStoredState(client), storedBeforeAutosaveFailure);

  await client.evaluate("window.confirm = () => true");
  await client.setFiles("#zipInput", [ZIP_FIXTURE]);
  await waitFor(
    () =>
      client.evaluate(`(() => {
        const payload = JSON.parse(document.querySelector("#jsonOutput").value);
        return payload.images.every((image) => image.status === "unlabeled") &&
          document.querySelector("#projectSaveState").dataset.state === "saved";
      })()`),
    "the fresh image set after autosave recovery",
    45_000,
  );

  await client.evaluate('document.querySelector("#markDoneButton").click()');
  await waitFor(
    () =>
      client.evaluate(`(() => {
        const payload = JSON.parse(document.querySelector("#jsonOutput").value);
        return payload.images[0].status === "done" &&
          document.querySelector("#projectSaveState").dataset.state === "saved";
      })()`),
    "the first image status save",
  );
  await client.evaluate('document.querySelector("#nextImageButton").click()');
  await waitFor(
    () => client.evaluate('document.querySelector("#projectPosition").textContent === "2 / 3"'),
    "the second image",
  );
  await client.evaluate('document.querySelector("#needsReviewButton").click()');
  await waitFor(
    () =>
      client.evaluate(`(() => {
        const payload = JSON.parse(document.querySelector("#jsonOutput").value);
        return payload.images[1].status === "needs_review" &&
          document.querySelector("#projectSaveState").dataset.state === "saved";
      })()`),
    "the second image status save",
  );

  const nativePreview = await client.evaluate(`(() => {
    const payload = JSON.parse(document.querySelector("#jsonOutput").value);
    const serialized = JSON.stringify(payload);
    return {
      kind: payload.kind,
      schemaVersion: payload.schemaVersion,
      paths: payload.images.map((image) => image.relativePath),
      statuses: payload.images.map((image) => image.status),
      currentImagePath: payload.imageSet.currentImagePath,
      progress: payload.progress,
      hasTopLevelId: Object.hasOwn(payload, "id") || Object.hasOwn(payload, "projectId"),
      hasImageId: payload.images.some((image) => Object.hasOwn(image, "id")),
      hasEmbeddedImage: /data:image|dataUrl|contentHash|sha-?256/i.test(serialized),
      hasLocalWriteToken: serialized.includes("localWriteToken"),
      hasAbsoluteWindowsPath: /[A-Za-z]:[\\/]/.test(serialized),
    };
  })()`);
  assert.equal(nativePreview.kind, "face-contour-annotations");
  assert.equal(nativePreview.schemaVersion, 1);
  assert.deepEqual(nativePreview.paths, EXPECTED_PATHS);
  assert.deepEqual(nativePreview.statuses, ["done", "needs_review", "unlabeled"]);
  assert.equal(nativePreview.currentImagePath, EXPECTED_PATHS[1]);
  assert.deepEqual(nativePreview.progress, {
    total: 3,
    done: 1,
    skipped: 0,
    needs_review: 1,
    in_progress: 0,
    unlabeled: 1,
  });
  assert.equal(nativePreview.hasTopLevelId, false);
  assert.equal(nativePreview.hasImageId, false);
  assert.equal(nativePreview.hasEmbeddedImage, false);
  assert.equal(nativePreview.hasLocalWriteToken, false);
  assert.equal(nativePreview.hasAbsoluteWindowsPath, false);

  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDirectory,
  });
  await client.evaluate('document.querySelector("#exportAnnotationsButton").click()');
  const downloadedAnnotationPath = await waitFor(() => {
    const files = readdirSync(downloadDirectory).filter(
      (name) => name.endsWith(".face-contour-annotations.json") && !name.endsWith(".crdownload"),
    );
    return files.length === 1 ? join(downloadDirectory, files[0]) : null;
  }, "the annotation JSON download");
  const downloadedAnnotations = JSON.parse(readFileSync(downloadedAnnotationPath, "utf8"));
  assert.equal(downloadedAnnotations.kind, "face-contour-annotations");
  assert.deepEqual(
    downloadedAnnotations.images.map((image) => image.relativePath),
    EXPECTED_PATHS,
  );
  assert.equal(JSON.stringify(downloadedAnnotations).includes("data:image"), false);

  await reloadPage(client);
  await waitFor(
    () =>
      client.evaluate(`(() => {
        try {
          const payload = JSON.parse(document.querySelector("#jsonOutput").value);
          return document.querySelector("#projectSaveState").dataset.state === "saved" &&
            payload.images[0].status === "done" &&
            payload.images[1].status === "needs_review" &&
            payload.imageSet.currentImagePath === ${JSON.stringify(EXPECTED_PATHS[1])};
        } catch (error) {
          return false;
        }
      })()`),
    "the saved image set after refresh",
    30_000,
  );
  const restored = await readBusinessState(client);
  assert.deepEqual(restored.paths, EXPECTED_PATHS);
  assert.deepEqual(restored.statuses, ["done", "needs_review", "unlabeled"]);
  assert.equal(restored.position, "2 / 3");

  const beforeCancelledImport = await readBusinessState(client);
  const storedBeforeCancelledImport = await readStoredState(client);
  await client.evaluate(`(() => {
    window.__confirmMessages = [];
    window.confirm = (message) => {
      window.__confirmMessages.push(String(message));
      return false;
    };
  })()`);
  await client.setFiles("#annotationFileInput", [PARTIAL_ANNOTATIONS_FIXTURE]);
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#statusText").textContent.includes("Annotation import cancelled")',
      ),
    "the cancelled annotation import",
  );
  assert.equal(await client.evaluate("window.__confirmMessages.length"), 1);
  assert.deepEqual(await readBusinessState(client), beforeCancelledImport);
  assert.deepEqual(await readStoredState(client), storedBeforeCancelledImport);

  await client.evaluate(`(() => {
    window.__confirmMessages = [];
    window.confirm = (message) => {
      window.__confirmMessages.push(String(message));
      return true;
    };
  })()`);
  await client.setFiles("#annotationFileInput", [PARTIAL_ANNOTATIONS_FIXTURE]);
  await waitFor(
    () =>
      client.evaluate(`(() => {
        const report = document.querySelector("#annotationImportReport");
        const payload = JSON.parse(document.querySelector("#jsonOutput").value);
        return !report.hidden &&
          document.querySelector("#annotationImportSummary").textContent === "1 applied · 1 unmatched · 1 conflicts" &&
          payload.images[0].status === "skipped" &&
          payload.images[1].status === "needs_review" &&
          document.querySelector("#projectSaveState").dataset.state === "saved";
      })()`),
    "the partial annotation import",
    30_000,
  );
  const importResult = await client.evaluate(`(() => ({
    confirmMessages: window.__confirmMessages,
    issueText: document.querySelector("#annotationImportIssues").textContent,
    reportOpenable: !document.querySelector("#annotationImportReport").hidden,
  }))()`);
  assert.equal(importResult.confirmMessages.length, 1);
  assert.match(importResult.confirmMessages[0], /replace existing work on 1 matching image/i);
  assert.match(importResult.issueText, /Unmatched: faces\/missing\.jpg/);
  assert.match(importResult.issueText, /Conflict: faces\/10-run-asset-type-samples\.png/);
  assert.equal(importResult.reportOpenable, true);
  const partialState = await readBusinessState(client);
  assert.deepEqual(partialState.statuses, ["skipped", "needs_review", "unlabeled"]);
  assert.equal(partialState.contourCounts[0], 0);
  assert.equal(partialState.currentImagePath, EXPECTED_PATHS[0]);
  assert.equal(partialState.position, "1 / 3");

  await reloadPage(client);
  await waitFor(
    () =>
      client.evaluate(`(() => {
        try {
          const payload = JSON.parse(document.querySelector("#jsonOutput").value);
          return payload.images[0].status === "skipped" &&
            payload.images[1].status === "needs_review" &&
            payload.imageSet.currentImagePath === ${JSON.stringify(EXPECTED_PATHS[0])} &&
            document.querySelector("#projectSaveState").dataset.state === "saved";
        } catch (error) {
          return false;
        }
      })()`),
    "the imported annotations after refresh",
    30_000,
  );

  const beforeCancelledReplacement = await readBusinessState(client);
  const storedBeforeCancelledReplacement = await readStoredState(client);
  await client.evaluate(`(() => {
    window.__confirmMessages = [];
    window.confirm = (message) => {
      window.__confirmMessages.push(String(message));
      return false;
    };
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([0])], "cancelled-replacement.jpg", {
      type: "image/jpeg",
      lastModified: 0,
    }));
    const imageInput = document.querySelector("#imageInput");
    imageInput.files = transfer.files;
    imageInput.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#statusText").textContent.includes("Opening another image set was cancelled")',
      ),
    "the cancelled image-set replacement",
  );
  assert.equal(await client.evaluate("window.__confirmMessages.length"), 1);
  assert.deepEqual(await readBusinessState(client), beforeCancelledReplacement);
  assert.deepEqual(await readStoredState(client), storedBeforeCancelledReplacement);

  await client.evaluate(`(() => {
    window.__confirmMessages = [];
    window.confirm = (message) => {
      window.__confirmMessages.push(String(message));
      return true;
    };
  })()`);
  const beforeBrokenZip = await readBusinessState(client);
  await client.setFiles("#zipInput", [BROKEN_ZIP_FIXTURE]);
  await waitFor(
    () =>
      client.evaluate(
        '/ZIP could not be read|corrupt|encrypted|unsupported|central directory|ZIP structure/i.test(document.querySelector("#statusText").textContent)',
      ),
    "the broken ZIP error",
  );
  const afterBrokenZip = await readBusinessState(client);
  assert.deepEqual(afterBrokenZip, beforeBrokenZip);
  assert.equal(await client.evaluate("window.__confirmMessages.length"), 1);

  await reloadPage(client);
  await waitFor(
    () =>
      client.evaluate(`(() => {
        try {
          const payload = JSON.parse(document.querySelector("#jsonOutput").value);
          return payload.images[0].status === "skipped" &&
            payload.images[1].status === "needs_review" &&
            document.querySelector("#projectSaveState").dataset.state === "saved";
        } catch (error) {
          return false;
        }
      })()`),
    "the preserved set after the broken ZIP and refresh",
    30_000,
  );

  const storedBeforeFailure = await readStoredState(client);
  const visibleBeforeFailure = await readBusinessState(client);
  await client.evaluate(`(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put");
    window.__e2eOriginalPutDescriptor = descriptor;
    window.__e2ePutFailureCount = 0;
    Object.defineProperty(IDBObjectStore.prototype, "put", {
      ...descriptor,
      value(value, key) {
        if (
          window.__e2ePutFailureCount === 0 &&
          this.name === "project-images" &&
          value?.status === "done"
        ) {
          window.__e2ePutFailureCount += 1;
          throw new Error("Forced annotation import transaction failure.");
        }
        return descriptor.value.call(this, value, key);
      },
    });
    window.confirm = () => true;
  })()`);
  await client.setFiles("#annotationFileInput", [ROLLBACK_ANNOTATIONS_FIXTURE]);
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#statusText").textContent.includes("Forced annotation import transaction failure")',
      ),
    "the forced annotation transaction failure",
    30_000,
  );
  const failureWasInjected = await client.evaluate(`(() => {
    const count = window.__e2ePutFailureCount;
    Object.defineProperty(
      IDBObjectStore.prototype,
      "put",
      window.__e2eOriginalPutDescriptor,
    );
    delete window.__e2eOriginalPutDescriptor;
    return count;
  })()`);
  assert.equal(failureWasInjected, 1);
  const visibleAfterFailure = await readBusinessState(client);
  const storedAfterFailure = await readStoredState(client);
  assert.deepEqual(visibleAfterFailure, visibleBeforeFailure);
  assert.deepEqual(storedAfterFailure, storedBeforeFailure);

  await reloadPage(client);
  await waitFor(
    () =>
      client.evaluate(`(() => {
        try {
          const payload = JSON.parse(document.querySelector("#jsonOutput").value);
          return payload.images[0].status === "skipped" &&
            payload.images[1].status === "needs_review" &&
            payload.imageSet.currentImagePath === ${JSON.stringify(EXPECTED_PATHS[0])} &&
            document.querySelector("#projectSaveState").dataset.state === "saved";
        } catch (error) {
          return false;
        }
      })()`),
    "the rolled-back annotations after refresh",
    30_000,
  );
  const finalState = await readBusinessState(client);
  assert.deepEqual(finalState, visibleBeforeFailure);

  const replacementSetup = await client.evaluate(`(async () => {
    const response = await fetch("/samples/face-lena.jpg", { cache: "no-store" });
    const sourceBytes = await response.arrayBuffer();
    const sourceFile = new File([sourceBytes], ${JSON.stringify(SOURCE_REPLACEMENT_IMAGE.split(/[\\/]/).at(-1))}, {
      type: "image/jpeg",
      lastModified: 0,
    });
    const transfer = new DataTransfer();
    transfer.items.add(sourceFile);
    const imageInput = document.querySelector("#imageInput");
    imageInput.files = transfer.files;

    const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put");
    window.__e2eReplacementPutDescriptor = descriptor;
    window.__e2eOldSetFlushCount = 0;
    window.__e2eReplacementFailureCount = 0;
    Object.defineProperty(IDBObjectStore.prototype, "put", {
      ...descriptor,
      value(value, key) {
        const storeNames = this.transaction.objectStoreNames;
        if (
          this.name === "project-images" &&
          storeNames.contains("projects") &&
          !storeNames.contains("project-image-assets")
        ) {
          window.__e2eOldSetFlushCount += 1;
        }
        if (
          window.__e2eReplacementFailureCount === 0 &&
          this.name === "project-image-assets"
        ) {
          window.__e2eReplacementFailureCount += 1;
          throw new Error("Forced image-set replacement transaction failure.");
        }
        return descriptor.value.call(this, value, key);
      },
    });
    window.__confirmMessages = [];
    window.confirm = (message) => {
      window.__confirmMessages.push(String(message));
      return true;
    };

    const showPoints = document.querySelector("#showPointsToggle");
    showPoints.checked = true;
    showPoints.dispatchEvent(new Event("change", { bubbles: true }));
    const saveStateAtDispatch = document.querySelector("#projectSaveState").dataset.state;
    imageInput.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      saveStateAtDispatch,
      showPointsAtDispatch: showPoints.checked,
    };
  })()`);
  assert.deepEqual(replacementSetup, {
    saveStateAtDispatch: "saving",
    showPointsAtDispatch: true,
  });
  const pendingOldState = await readBusinessState(client);
  assert.equal(pendingOldState.showPoints, true);
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#statusText").textContent.includes("Forced image-set replacement transaction failure")',
      ),
    "the forced image-set replacement transaction failure",
    30_000,
  );
  const replacementFailureEvidence = await client.evaluate(`(() => {
    const evidence = {
      oldSetFlushCount: window.__e2eOldSetFlushCount,
      replacementFailureCount: window.__e2eReplacementFailureCount,
      confirmMessages: window.__confirmMessages,
    };
    Object.defineProperty(
      IDBObjectStore.prototype,
      "put",
      window.__e2eReplacementPutDescriptor,
    );
    delete window.__e2eReplacementPutDescriptor;
    return evidence;
  })()`);
  assert.equal(replacementFailureEvidence.oldSetFlushCount >= 1, true);
  assert.equal(replacementFailureEvidence.replacementFailureCount, 1);
  assert.equal(replacementFailureEvidence.confirmMessages.length, 1);
  assert.match(replacementFailureEvidence.confirmMessages[0], /open a different image set/i);
  const afterReplacementFailure = await readBusinessState(client);
  assert.deepEqual(afterReplacementFailure, pendingOldState);
  const storedAfterReplacementFailure = await readStoredState(client);
  assert.equal(storedAfterReplacementFailure.metadata.name, "image-set");
  assert.equal(storedAfterReplacementFailure.metadata.preferences.showPoints, true);
  assert.deepEqual(
    storedAfterReplacementFailure.records.map((record) => record.status),
    ["skipped", "needs_review", "unlabeled"],
  );

  await reloadPage(client);
  await waitFor(
    () =>
      client.evaluate(`(() => {
        try {
          const payload = JSON.parse(document.querySelector("#jsonOutput").value);
          return document.querySelector("#projectName").textContent === "image-set" &&
            payload.images[0].status === "skipped" &&
            payload.images[1].status === "needs_review" &&
            payload.imageSet.currentImagePath === ${JSON.stringify(EXPECTED_PATHS[0])} &&
            document.querySelector("#showPointsToggle").checked &&
            document.querySelector("#projectSaveState").dataset.state === "saved";
        } catch (error) {
          return false;
        }
      })()`),
    "the old image set after failed replacement and refresh",
    30_000,
  );
  const restoredAfterReplacementFailure = await readBusinessState(client);
  assert.deepEqual(restoredAfterReplacementFailure, pendingOldState);

  const localWriteSafetyEvidence = await client.evaluate(`(async () => {
    const storage = await import("/src/storage.js?v=image-set-annotations-1");
    const config = await import("/src/config.js?v=image-set-annotations-1");
    const metadata = await storage.getCurrentProject();
    const records = await storage.getProjectImageRecords(
      metadata.images.map((image) => image.id),
    );
    const assets = await Promise.all(
      metadata.images.map((image) => storage.getProjectImageAsset(image.id)),
    );
    const fullProject = {
      ...metadata,
      images: metadata.images.map((image, index) => ({
        ...image,
        ...records[index],
        dataUrl: assets[index].dataUrl,
      })),
    };
    const staleProject = structuredClone(fullProject);
    const replacementProject = {
      ...structuredClone(fullProject),
      localWriteToken: crypto.randomUUID(),
    };
    await storage.replaceCurrentProjectData(replacementProject);
    const staleImage = {
      ...staleProject.images[0],
      status: "done",
      updatedAt: new Date().toISOString(),
    };
    staleProject.images[0] = staleImage;
    let staleWriteCode = null;
    try {
      await storage.putProjectSnapshot({ project: staleProject, image: staleImage });
    } catch (error) {
      staleWriteCode = error.code || null;
    }
    const afterStaleMetadata = await storage.getCurrentProject();
    const afterStaleRecord = await storage.getProjectImageRecord(staleImage.id);

    const tokenlessExpectedProject = structuredClone(fullProject);
    delete tokenlessExpectedProject.localWriteToken;
    const staleMigrationProject = {
      ...structuredClone(tokenlessExpectedProject),
      localWriteToken: crypto.randomUUID(),
    };
    let staleMigrationCode = null;
    try {
      await storage.replaceCurrentProjectDataIfUnchanged({
        expectedProject: tokenlessExpectedProject,
        project: staleMigrationProject,
      });
    } catch (error) {
      staleMigrationCode = error.code || null;
    }
    let staleTokenClaimCode = null;
    try {
      await storage.claimCurrentProjectWriteToken({
        expectedProject: tokenlessExpectedProject,
        project: staleMigrationProject,
      });
    } catch (error) {
      staleTokenClaimCode = error.code || null;
    }
    const afterStaleMigrationMetadata = await storage.getCurrentProject();

    const legacyProject = {
      ...structuredClone(replacementProject),
      localWriteToken: crypto.randomUUID(),
    };
    await storage.clearCurrentProjectData();
    await new Promise((resolveWrite, rejectWrite) => {
      const openRequest = indexedDB.open(config.DRAFT_DB_NAME, config.DRAFT_DB_VERSION);
      openRequest.onerror = () => rejectWrite(openRequest.error);
      openRequest.onsuccess = () => {
        const database = openRequest.result;
        const transaction = database.transaction(config.PROJECT_STORE_NAME, "readwrite");
        transaction.objectStore(config.PROJECT_STORE_NAME).put(
          legacyProject,
          config.CURRENT_PROJECT_KEY,
        );
        transaction.oncomplete = () => {
          database.close();
          resolveWrite();
        };
        transaction.onerror = () => {
          database.close();
          rejectWrite(transaction.error);
        };
      };
    });

    const putDescriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put");
    let legacyFailureCount = 0;
    Object.defineProperty(IDBObjectStore.prototype, "put", {
      ...putDescriptor,
      value(value, key) {
        if (legacyFailureCount === 0 && this.name === config.PROJECT_IMAGE_STORE_NAME) {
          legacyFailureCount += 1;
          throw new Error("Forced legacy migration transaction failure.");
        }
        return putDescriptor.value.call(this, value, key);
      },
    });
    let legacyRejected = false;
    try {
      await storage.replaceCurrentProjectData(legacyProject);
    } catch (error) {
      legacyRejected = true;
    } finally {
      Object.defineProperty(IDBObjectStore.prototype, "put", putDescriptor);
    }
    const preservedLegacy = await storage.getCurrentProject();
    const preservedRecords = await storage.getProjectImageRecords(
      legacyProject.images.map((image) => image.id),
    );
    const preservedAssets = await Promise.all(
      legacyProject.images.map((image) => storage.getProjectImageAsset(image.id)),
    );
    return {
      staleWriteCode,
      replacementTokenPreserved:
        afterStaleMetadata.localWriteToken === replacementProject.localWriteToken,
      staleRecordDidNotOverwrite: afterStaleRecord.status === records[0].status,
      staleMigrationCode,
      staleTokenClaimCode,
      staleMigrationDidNotOverwrite:
        afterStaleMigrationMetadata.localWriteToken === replacementProject.localWriteToken,
      legacyFailureCount,
      legacyRejected,
      legacyPayloadPreserved:
        JSON.stringify(preservedLegacy) === JSON.stringify(legacyProject),
      legacyRecordsStayedEmpty: preservedRecords.every((record) => record === null),
      legacyAssetsStayedEmpty: preservedAssets.every((asset) => asset === null),
    };
  })()`);
  assert.deepEqual(localWriteSafetyEvidence, {
    staleWriteCode: "STALE_IMAGE_SET_WRITE",
    replacementTokenPreserved: true,
    staleRecordDidNotOverwrite: true,
    staleMigrationCode: "STALE_IMAGE_SET_WRITE",
    staleTokenClaimCode: "STALE_IMAGE_SET_WRITE",
    staleMigrationDidNotOverwrite: true,
    legacyFailureCount: 1,
    legacyRejected: true,
    legacyPayloadPreserved: true,
    legacyRecordsStayedEmpty: true,
    legacyAssetsStayedEmpty: true,
  });

  await reloadPage(client);
  await waitFor(
    () =>
      client.evaluate(`(() => {
        try {
          const payload = JSON.parse(document.querySelector("#jsonOutput").value);
          return document.querySelector("#projectName").textContent === "image-set" &&
            payload.images[0].status === "skipped" &&
            payload.images[1].status === "needs_review" &&
            document.querySelector("#projectSaveState").dataset.state === "saved";
        } catch (error) {
          return false;
        }
      })()`),
    "the legacy image set after atomic migration recovery",
    30_000,
  );
  assert.deepEqual(await readBusinessState(client), restoredAfterReplacementFailure);
  console.log("browser image-set workflow test passed");
} finally {
  if (client) {
    try {
      await Promise.race([client.send("Browser.close"), delay(3000)]);
    } catch (error) {
      console.warn("Chrome did not close through CDP.", error);
    }
  }
  if (browserProcess.exitCode === null) {
    const exitedGracefully = await waitForChildExit(browserProcess, 5000);
    if (!exitedGracefully) {
      browserProcess.kill();
      await waitForChildExit(browserProcess, 5000);
    }
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  const cleanupAttempts = 100;
  for (let attempt = 0; attempt < cleanupAttempts; attempt += 1) {
    try {
      rmSync(resolvedProfileDirectory, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === cleanupAttempts - 1) {
        console.warn(`Temporary browser profile could not be removed: ${relative(tmpdir(), profileDirectory)}`);
      } else {
        await delay(100);
      }
    }
  }
}
