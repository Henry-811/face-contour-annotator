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
const PARTIAL_ANNOTATIONS_FIXTURE = resolve(
  WORKSPACE,
  "tests/fixtures/partial.face-contour-annotations.json",
);
const SOURCE_REPLACEMENT_IMAGE = resolve(WORKSPACE, "samples/face-lena.jpg");
const EXPECTED_PATHS = [
  "faces/2-face-lena.jpg",
  "faces/10-run-asset-type-samples.png",
  "faces/20-large-worker.bmp",
];
const LEGACY_PROJECT_NAME = "Legacy v3 project";
const LEGACY_IMAGE_ID = "legacy-v3-image";
const LEGACY_IMAGE_PATH = "legacy/face-lena.jpg";
const LEGACY_PROJECT_UPDATED_AT = "2026-08-04T08:00:00.000Z";
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
      if (pathname === "/__browser_test_seed__.html") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
        });
        response.end("<!doctype html><html><head><title>Database seed</title></head><body></body></html>");
        return;
      }
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

async function readStoredState(client, localProjectKey) {
  return client.evaluate(`(async () => {
    const storage = await import("/src/storage.js?v=browser-image-set-storage-inspection");
    const metadata = await storage.getLocalProject(${JSON.stringify(localProjectKey)});
    if (!metadata) {
      return null;
    }
    const imageIds = metadata.images.map((image) => image.id);
    const records = await storage.getLocalProjectImageRecords(
      ${JSON.stringify(localProjectKey)},
      imageIds,
    );
    const assets = await Promise.all(
      imageIds.map((imageId) =>
        storage.getLocalProjectImageAsset(${JSON.stringify(localProjectKey)}, imageId)
      ),
    );
    return {
      metadata,
      records,
      assetIds: assets.map((asset) => asset?.id || null),
    };
  })()`);
}

async function readStoredProjects(client) {
  return client.evaluate(`(async () => {
    const storage = await import("/src/storage.js?v=browser-image-set-library-inspection");
    return storage.listLocalProjects();
  })()`);
}

async function readProjectStoreCounts(client) {
  return client.evaluate(`(async () => {
    const config = await import("/src/config.js?v=browser-image-set-count-inspection");
    const database = await new Promise((resolveOpen, rejectOpen) => {
      const request = indexedDB.open(config.DRAFT_DB_NAME, config.DRAFT_DB_VERSION);
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => rejectOpen(request.error);
    });
    try {
      const transaction = database.transaction(
        [
          config.PROJECT_STORE_NAME,
          config.PROJECT_IMAGE_STORE_NAME,
          config.PROJECT_IMAGE_ASSET_STORE_NAME,
        ],
        "readonly",
      );
      const count = (storeName) => new Promise((resolveCount, rejectCount) => {
        const request = transaction.objectStore(storeName).count();
        request.onsuccess = () => resolveCount(request.result);
        request.onerror = () => rejectCount(request.error);
      });
      const [projects, records, assets] = await Promise.all([
        count(config.PROJECT_STORE_NAME),
        count(config.PROJECT_IMAGE_STORE_NAME),
        count(config.PROJECT_IMAGE_ASSET_STORE_NAME),
      ]);
      return { projects, records, assets };
    } finally {
      database.close();
    }
  })()`);
}

async function seedLegacyV3Project(client) {
  return client.evaluate(`(async () => {
    const config = await import("/src/config.js?v=browser-legacy-v3-seed");
    await new Promise((resolveDelete, rejectDelete) => {
      const request = indexedDB.deleteDatabase(config.DRAFT_DB_NAME);
      request.onsuccess = () => resolveDelete();
      request.onerror = () => rejectDelete(request.error);
      request.onblocked = () => rejectDelete(new Error("Legacy seed database deletion was blocked."));
    });
    const response = await fetch("/samples/face-lena.jpg", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Legacy source image could not be fetched.");
    }
    const sourceBlob = await response.blob();
    const dataUrl = await new Promise((resolveDataUrl, rejectDataUrl) => {
      const reader = new FileReader();
      reader.onload = () => resolveDataUrl(reader.result);
      reader.onerror = () => rejectDataUrl(reader.error);
      reader.readAsDataURL(sourceBlob);
    });
    const contour = {
      id: "legacy-face-outline",
      label: "face_outline",
      closed: true,
      points: [
        { x: 96, y: 72 },
        { x: 416, y: 72 },
        { x: 416, y: 440 },
        { x: 96, y: 440 },
      ],
    };
    const imageMetadata = {
      id: ${JSON.stringify(LEGACY_IMAGE_ID)},
      name: "face-lena.jpg",
      path: ${JSON.stringify(LEGACY_IMAGE_PATH)},
      width: 512,
      height: 512,
      status: "needs_review",
      selectedId: contour.id,
      updatedAt: ${JSON.stringify(LEGACY_PROJECT_UPDATED_AT)},
    };
    const legacyProject = {
      name: ${JSON.stringify(LEGACY_PROJECT_NAME)},
      version: "face-contour-project-v1",
      source: {
        type: "folder",
        importedAt: ${JSON.stringify(LEGACY_PROJECT_UPDATED_AT)},
      },
      localWriteToken: "legacy-v3-write-token",
      taskSchema: { labels: [] },
      images: [imageMetadata],
      currentImageId: imageMetadata.id,
      preferences: {
        activeLabel: "face_outline",
        mode: "refine",
        drawClosed: true,
        softDrag: true,
        showPoints: true,
        softRadius: 40,
        imageZoom: 1,
      },
      createdAt: ${JSON.stringify(LEGACY_PROJECT_UPDATED_AT)},
      updatedAt: ${JSON.stringify(LEGACY_PROJECT_UPDATED_AT)},
    };
    const database = await new Promise((resolveOpen, rejectOpen) => {
      const request = indexedDB.open(config.DRAFT_DB_NAME, 3);
      request.onupgradeneeded = () => {
        const opened = request.result;
        [
          config.DRAFT_STORE_NAME,
          config.PROJECT_STORE_NAME,
          config.PROJECT_IMAGE_STORE_NAME,
          config.PROJECT_IMAGE_ASSET_STORE_NAME,
        ].forEach((storeName) => {
          if (!opened.objectStoreNames.contains(storeName)) {
            opened.createObjectStore(storeName);
          }
        });
      };
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => rejectOpen(request.error);
      request.onblocked = () => rejectOpen(new Error("Legacy seed database open was blocked."));
    });
    try {
      await new Promise((resolveWrite, rejectWrite) => {
        const transaction = database.transaction(
          [
            config.PROJECT_STORE_NAME,
            config.PROJECT_IMAGE_STORE_NAME,
            config.PROJECT_IMAGE_ASSET_STORE_NAME,
          ],
          "readwrite",
        );
        transaction.objectStore(config.PROJECT_STORE_NAME).put(
          legacyProject,
          config.LEGACY_CURRENT_PROJECT_KEY,
        );
        transaction.objectStore(config.PROJECT_IMAGE_STORE_NAME).put(
          { ...imageMetadata, contours: [contour] },
          imageMetadata.id,
        );
        transaction.objectStore(config.PROJECT_IMAGE_ASSET_STORE_NAME).put(
          {
            id: imageMetadata.id,
            dataUrl,
            updatedAt: imageMetadata.updatedAt,
          },
          imageMetadata.id,
        );
        transaction.oncomplete = () => resolveWrite();
        transaction.onerror = () =>
          rejectWrite(transaction.error || new Error("Legacy seed transaction failed."));
        transaction.onabort = () =>
          rejectWrite(transaction.error || new Error("Legacy seed transaction aborted."));
      });
      return {
        databaseVersion: database.version,
        projectKey: config.LEGACY_CURRENT_PROJECT_KEY,
        imageId: imageMetadata.id,
        dataUrlLength: dataUrl.length,
      };
    } finally {
      database.close();
    }
  })()`);
}

async function readRawProjectStorageEntry(client, { localProjectKey, imageId }) {
  return client.evaluate(`(async () => {
    const config = await import("/src/config.js?v=browser-raw-project-storage");
    const database = await new Promise((resolveOpen, rejectOpen) => {
      const request = indexedDB.open(config.DRAFT_DB_NAME, config.DRAFT_DB_VERSION);
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => rejectOpen(request.error);
    });
    try {
      const transaction = database.transaction(
        [
          config.PROJECT_STORE_NAME,
          config.PROJECT_IMAGE_STORE_NAME,
          config.PROJECT_IMAGE_ASSET_STORE_NAME,
        ],
        "readonly",
      );
      const read = (storeName, key) => new Promise((resolveRead, rejectRead) => {
        const request = transaction.objectStore(storeName).get(key);
        request.onsuccess = () => resolveRead(request.result || null);
        request.onerror = () => rejectRead(request.error);
      });
      const readKeys = (storeName) => new Promise((resolveRead, rejectRead) => {
        const request = transaction.objectStore(storeName).getAllKeys();
        request.onsuccess = () => resolveRead(request.result);
        request.onerror = () => rejectRead(request.error);
      });
      const [
        legacyMetadata,
        metadata,
        record,
        asset,
        projectKeys,
        recordKeys,
        assetKeys,
      ] = await Promise.all([
        read(config.PROJECT_STORE_NAME, config.LEGACY_CURRENT_PROJECT_KEY),
        read(config.PROJECT_STORE_NAME, ${JSON.stringify(localProjectKey)}),
        read(config.PROJECT_IMAGE_STORE_NAME, ${JSON.stringify(imageId)}),
        read(config.PROJECT_IMAGE_ASSET_STORE_NAME, ${JSON.stringify(imageId)}),
        readKeys(config.PROJECT_STORE_NAME),
        readKeys(config.PROJECT_IMAGE_STORE_NAME),
        readKeys(config.PROJECT_IMAGE_ASSET_STORE_NAME),
      ]);
      return {
        databaseVersion: database.version,
        legacyMetadata,
        metadata,
        record,
        asset,
        projectKeys,
        recordKeys,
        assetKeys,
      };
    } finally {
      database.close();
    }
  })()`);
}

async function readHubState(client) {
  return client.evaluate(`(() => ({
    hubVisible: document.querySelector("#projectHubView").hidden === false,
    workspaceHidden: document.querySelector("#annotationWorkspaceView").hidden === true,
    countLabel: document.querySelector("#projectLibraryCount").textContent.trim(),
    emptyVisible: document.querySelector("#projectListEmpty").hidden === false,
    names: Array.from(document.querySelectorAll(".project-card-name"), (node) =>
      node.textContent.trim()
    ),
    progress: Array.from(document.querySelectorAll(".project-card-progress"), (node) =>
      node.textContent.trim()
    ),
    status: document.querySelector("#hubStatusText").textContent.trim(),
    hash: window.location.hash,
  }))()`);
}

async function clickProjectCardAction(client, projectName, actionSelector) {
  return waitFor(() => client.evaluate(`(() => {
    const card = Array.from(document.querySelectorAll(".project-card")).find(
      (candidate) =>
        candidate.querySelector(".project-card-name")?.textContent.trim() ===
        ${JSON.stringify(projectName)},
    );
    if (!card) {
      throw new Error("Project card was not found: " + ${JSON.stringify(projectName)});
    }
    const action = card.querySelector(${JSON.stringify(actionSelector)});
    if (!action) {
      throw new Error("Project card action was not found: " + ${JSON.stringify(actionSelector)});
    }
    // The hub can become visible before its asynchronous refresh/save barrier
    // finishes. A real user cannot activate a still-disabled project action.
    if (action.disabled) return false;
    action.click();
    return true;
  })()`), `enabled ${actionSelector} for ${projectName}`);
}

let reloadSequence = 0;

async function reloadPage(client) {
  reloadSequence += 1;
  const previousDocumentMarker = `before-reload-${reloadSequence}`;
  await client.evaluate(
    `document.documentElement.dataset.e2eReloadMarker = ${JSON.stringify(previousDocumentMarker)}`,
  );
  const eventOffset = client.events.length;
  const reloadUrl = new URL(await client.evaluate("window.location.href"));
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
    console.log("browser image-set workflow test skipped (" + reason + ")");
    process.exit(0);
  }
  throw new Error(
    reason +
      ". Set CHROME_BIN, or set ALLOW_BROWSER_TEST_SKIP=1 only when an explicit skip is intended.",
  );
}

const server = await startStaticServer();
const address = server.address();
const appUrl =
  "http://127.0.0.1:" + address.port + "/?browser-image-set-workflow=1";
const seedUrl = "http://127.0.0.1:" + address.port + "/__browser_test_seed__.html";
const profileDirectory = mkdtempSync(join(tmpdir(), "face-contour-browser-test-"));
const resolvedProfileDirectory = resolve(profileDirectory);
const resolvedTemporaryRoot = resolve(tmpdir());
assert.equal(
  resolvedProfileDirectory.startsWith(resolvedTemporaryRoot + sep),
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
        "workers/" + String(index + 1).padStart(2, "0") + ".jpg",
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
    "--user-data-dir=" + profileDirectory,
    "--remote-debugging-port=0",
    seedUrl,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let client = null;
try {
  const browserWebSocketUrl = await waitForDevTools(browserProcess);
  const browserEndpoint = new URL(browserWebSocketUrl);
  const target = await waitFor(async () => {
    const response = await fetch("http://" + browserEndpoint.host + "/json/list");
    const targets = await response.json();
    return targets.find((item) => item.type === "page" && item.url.startsWith(seedUrl));
  }, "the database seed page target");
  client = await CdpClient.connect(target.webSocketDebuggerUrl);
  await Promise.all([
    client.send("DOM.enable"),
    client.send("Page.enable"),
    client.send("Runtime.enable"),
  ]);
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const seedNavigation = await client.send("Page.navigate", { url: seedUrl });
  if (seedNavigation.errorText) {
    throw new Error("Legacy database seed navigation failed: " + seedNavigation.errorText);
  }
  await waitFor(
    () =>
      client.evaluate(
        'document.readyState === "complete" && document.title === "Database seed"',
      ),
    "the legacy database seed page",
  );
  const legacySeed = await seedLegacyV3Project(client);
  assert.equal(legacySeed.databaseVersion, 3);
  assert.equal(legacySeed.projectKey, "current-project");
  assert.equal(legacySeed.imageId, LEGACY_IMAGE_ID);
  assert.equal(legacySeed.dataUrlLength > 1000, true);

  const initialNavigation = await client.send("Page.navigate", { url: appUrl });
  if (initialNavigation.errorText) {
    throw new Error("Initial application navigation failed: " + initialNavigation.errorText);
  }
  await waitFor(
    () =>
      client.evaluate(
        'document.readyState === "complete" && document.querySelector("#projectHubView").hidden === false && document.querySelector("#projectLibraryCount").textContent.trim() === "1 project" && document.querySelector("#hubStatusText").textContent.includes("Recovered the previous image set")',
      ),
    "the migrated legacy project in the hub",
    30_000,
  );

  const migratedProjects = await readStoredProjects(client);
  assert.equal(migratedProjects.length, 1);
  const [migratedLegacyProject] = migratedProjects;
  assert.equal(migratedLegacyProject.name, LEGACY_PROJECT_NAME);
  assert.notEqual(migratedLegacyProject.localProjectKey, "current-project");
  assert.equal(migratedLegacyProject.images[0].id, LEGACY_IMAGE_ID);
  const migratedRawState = await readRawProjectStorageEntry(client, {
    localProjectKey: migratedLegacyProject.localProjectKey,
    imageId: LEGACY_IMAGE_ID,
  });
  assert.equal(migratedRawState.databaseVersion, 4);
  assert.equal(migratedRawState.legacyMetadata, null);
  assert.equal(
    migratedRawState.metadata.localProjectKey,
    migratedLegacyProject.localProjectKey,
  );
  assert.equal(migratedRawState.metadata.images[0].id, LEGACY_IMAGE_ID);
  assert.equal(migratedRawState.record.status, "needs_review");
  assert.equal(migratedRawState.record.contours[0].id, "legacy-face-outline");
  assert.equal(migratedRawState.asset.id, LEGACY_IMAGE_ID);
  assert.match(migratedRawState.asset.dataUrl, /^data:image\/jpeg;base64,/);
  assert.deepEqual(await readProjectStoreCounts(client), {
    projects: 1,
    records: 1,
    assets: 1,
  });

  await clickProjectCardAction(client, LEGACY_PROJECT_NAME, ".open-project-button");
  await waitFor(
    () =>
      client.evaluate(
        '(() => { try { const payload = JSON.parse(document.querySelector("#jsonOutput").value); return document.querySelector("#projectName").textContent === "Legacy v3 project" && payload.images[0].relativePath === "legacy/face-lena.jpg" && payload.images[0].status === "needs_review" && payload.images[0].contours.length === 1 && document.querySelector("#projectSaveState").dataset.state === "saved"; } catch (error) { return false; } })()',
      ),
    "the migrated legacy project workspace",
    30_000,
  );
  const migratedProjectHash = await client.evaluate("window.location.hash");
  assert.match(migratedProjectHash, /^#\/project\/[^/]+$/);
  const migratedBusinessState = await readBusinessState(client);
  assert.equal(migratedBusinessState.imageSize, "512 x 512");
  assert.equal(migratedBusinessState.showPoints, true);
  assert.deepEqual(migratedBusinessState.contourCounts, [1]);
  await reloadPage(client);
  await waitFor(
    () =>
      client.evaluate(
        '(() => { try { const payload = JSON.parse(document.querySelector("#jsonOutput").value); return document.querySelector("#projectName").textContent === "Legacy v3 project" && payload.images[0].status === "needs_review" && payload.images[0].contours.length === 1 && document.querySelector("#projectSaveState").dataset.state === "saved"; } catch (error) { return false; } })()',
      ),
    "the migrated legacy project after refresh",
    30_000,
  );
  assert.equal(await client.evaluate("window.location.hash"), migratedProjectHash);
  await client.evaluate('document.querySelector("#exitProjectButton").click()');
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectHubView").hidden === false && document.querySelector("#projectLibraryCount").textContent.trim() === "1 project"',
      ),
    "the hub after closing the migrated legacy project",
  );
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 320,
    height: 720,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await waitFor(
    () => client.evaluate("window.innerWidth === 320 && window.innerHeight === 720"),
    "the narrow mobile hub viewport",
  );
  const narrowHubEvidence = await client.evaluate(`(() => {
    const hub = document.querySelector("#projectHubView");
    const actions = document.querySelector(".project-card-actions");
    const actionBounds = actions.getBoundingClientRect();
    const buttons = Array.from(actions.querySelectorAll("button"));
    return {
      flexDirection: getComputedStyle(actions).flexDirection,
      horizontalOverflow: hub.scrollWidth > hub.clientWidth + 1,
      buttonsInsideActions: buttons.every((button) => {
        const bounds = button.getBoundingClientRect();
        return bounds.left >= actionBounds.left - 1 && bounds.right <= actionBounds.right + 1;
      }),
      buttonHeights: buttons.map((button) => button.getBoundingClientRect().height),
    };
  })()`);
  assert.equal(narrowHubEvidence.flexDirection, "column");
  assert.equal(narrowHubEvidence.horizontalOverflow, false);
  assert.equal(narrowHubEvidence.buttonsInsideActions, true);
  assert.equal(narrowHubEvidence.buttonHeights.every((height) => height >= 44), true);
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(
    () => client.evaluate("window.innerWidth === 1440 && window.innerHeight === 1000"),
    "the restored desktop hub viewport",
  );
  await client.evaluate("window.confirm = () => true");
  await clickProjectCardAction(client, LEGACY_PROJECT_NAME, ".delete-project-button");
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectLibraryCount").textContent.trim() === "0 projects"',
      ),
    "the migrated legacy project deletion",
  );
  const deletedLegacyRawState = await readRawProjectStorageEntry(client, {
    localProjectKey: migratedLegacyProject.localProjectKey,
    imageId: LEGACY_IMAGE_ID,
  });
  assert.equal(deletedLegacyRawState.legacyMetadata, null);
  assert.equal(deletedLegacyRawState.metadata, null);
  assert.equal(deletedLegacyRawState.record, null);
  assert.equal(deletedLegacyRawState.asset, null);
  assert.deepEqual(await readProjectStoreCounts(client), {
    projects: 0,
    records: 0,
    assets: 0,
  });

  const rollbackSeedNavigation = await client.send("Page.navigate", { url: seedUrl });
  if (rollbackSeedNavigation.errorText) {
    throw new Error(
      "Legacy migration rollback seed navigation failed: " +
        rollbackSeedNavigation.errorText,
    );
  }
  await waitFor(
    () =>
      client.evaluate(
        'document.readyState === "complete" && document.title === "Database seed"',
      ),
    "the legacy migration rollback seed page",
  );
  const rollbackLegacySeed = await seedLegacyV3Project(client);
  assert.equal(rollbackLegacySeed.databaseVersion, 3);
  assert.equal(rollbackLegacySeed.projectKey, "current-project");
  assert.equal(rollbackLegacySeed.imageId, LEGACY_IMAGE_ID);

  const { identifier: legacyMigrationFailureScriptId } = await client.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `(() => {
        const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "add");
        window.__legacyMigrationAddDescriptor = descriptor;
        window.__legacyMigrationAddFailureCount = 0;
        Object.defineProperty(IDBObjectStore.prototype, "add", {
          ...descriptor,
          value(value, key) {
            if (
              window.__legacyMigrationAddFailureCount === 0 &&
              this.name === "projects" &&
              key !== "current-project"
            ) {
              window.__legacyMigrationAddFailureCount += 1;
              throw new Error("Forced legacy metadata migration failure.");
            }
            return descriptor.value.call(this, value, key);
          },
        });
      })();`,
    },
  );
  const failedMigrationUrl = new URL(appUrl);
  failedMigrationUrl.searchParams.set("legacy-migration-rollback", "1");
  const failedMigrationNavigation = await client.send("Page.navigate", {
    url: failedMigrationUrl.href,
  });
  if (failedMigrationNavigation.errorText) {
    throw new Error(
      "Forced legacy migration navigation failed: " + failedMigrationNavigation.errorText,
    );
  }
  await waitFor(
    () =>
      client.evaluate(
        'document.readyState === "complete" && document.querySelector("#projectHubView").hidden === false && document.querySelector("#projectLibraryCount").textContent.trim() === "0 projects" && document.querySelector("#hubStatusText").textContent.includes("Previous local work could not be migrated")',
      ),
    "the forced legacy migration failure in the hub",
    30_000,
  );
  assert.deepEqual(await readStoredProjects(client), []);
  assert.deepEqual(await readProjectStoreCounts(client), {
    projects: 1,
    records: 1,
    assets: 1,
  });
  const failedMigrationRawState = await readRawProjectStorageEntry(client, {
    localProjectKey: "missing-after-failed-migration",
    imageId: LEGACY_IMAGE_ID,
  });
  assert.equal(failedMigrationRawState.databaseVersion, 4);
  assert.equal(failedMigrationRawState.legacyMetadata.name, LEGACY_PROJECT_NAME);
  assert.equal(failedMigrationRawState.legacyMetadata.images[0].id, LEGACY_IMAGE_ID);
  assert.equal(failedMigrationRawState.metadata, null);
  assert.equal(failedMigrationRawState.record.status, "needs_review");
  assert.equal(failedMigrationRawState.record.contours[0].id, "legacy-face-outline");
  assert.equal(failedMigrationRawState.asset.id, LEGACY_IMAGE_ID);
  assert.match(failedMigrationRawState.asset.dataUrl, /^data:image\/jpeg;base64,/);
  assert.deepEqual(failedMigrationRawState.projectKeys, ["current-project"]);
  assert.deepEqual(failedMigrationRawState.recordKeys, [LEGACY_IMAGE_ID]);
  assert.deepEqual(failedMigrationRawState.assetKeys, [LEGACY_IMAGE_ID]);

  await client.send("Page.removeScriptToEvaluateOnNewDocument", {
    identifier: legacyMigrationFailureScriptId,
  });
  const legacyMigrationAddFailureCount = await client.evaluate(`(() => {
    const count = window.__legacyMigrationAddFailureCount;
    Object.defineProperty(
      IDBObjectStore.prototype,
      "add",
      window.__legacyMigrationAddDescriptor
    );
    delete window.__legacyMigrationAddDescriptor;
    return count;
  })()`);
  assert.equal(legacyMigrationAddFailureCount, 1);

  await reloadPage(client);
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectHubView").hidden === false && document.querySelector("#projectLibraryCount").textContent.trim() === "1 project" && document.querySelector("#hubStatusText").textContent.includes("Recovered the previous image set")',
      ),
    "the legacy migration retry",
    30_000,
  );
  const retriedMigrationProjects = await readStoredProjects(client);
  assert.equal(retriedMigrationProjects.length, 1);
  const [retriedMigrationProject] = retriedMigrationProjects;
  assert.equal(retriedMigrationProject.name, LEGACY_PROJECT_NAME);
  assert.notEqual(retriedMigrationProject.localProjectKey, "current-project");
  const retriedMigrationRawState = await readRawProjectStorageEntry(client, {
    localProjectKey: retriedMigrationProject.localProjectKey,
    imageId: LEGACY_IMAGE_ID,
  });
  assert.equal(retriedMigrationRawState.legacyMetadata, null);
  assert.equal(
    retriedMigrationRawState.metadata.localProjectKey,
    retriedMigrationProject.localProjectKey,
  );
  assert.equal(retriedMigrationRawState.record.status, "needs_review");
  assert.equal(retriedMigrationRawState.asset.id, LEGACY_IMAGE_ID);
  assert.deepEqual(retriedMigrationRawState.projectKeys, [
    retriedMigrationProject.localProjectKey,
  ]);
  assert.deepEqual(retriedMigrationRawState.recordKeys, [LEGACY_IMAGE_ID]);
  assert.deepEqual(retriedMigrationRawState.assetKeys, [LEGACY_IMAGE_ID]);

  await client.evaluate("window.confirm = () => true");
  await clickProjectCardAction(client, LEGACY_PROJECT_NAME, ".delete-project-button");
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectLibraryCount").textContent.trim() === "0 projects" && document.querySelector("#hubStatusText").textContent.includes("Deleted the local copy")',
      ),
    "the retried legacy migration cleanup",
    30_000,
  );
  assert.deepEqual(await readProjectStoreCounts(client), {
    projects: 0,
    records: 0,
    assets: 0,
  });

  await reloadPage(client);
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectHubView").hidden === false && document.querySelector("#projectLibraryCount").textContent.trim() === "0 projects" && document.querySelector("#hubStatusText").textContent.includes("Choose a project")',
      ),
    "the empty project hub after legacy migration verification",
    30_000,
  );

  const emptyHub = await readHubState(client);
  assert.deepEqual(emptyHub, {
    hubVisible: true,
    workspaceHidden: true,
    countLabel: "0 projects",
    emptyVisible: true,
    names: [],
    progress: [],
    status: "Choose a project to continue.",
    hash: "",
  });
  assert.deepEqual(await readProjectStoreCounts(client), {
    projects: 0,
    records: 0,
    assets: 0,
  });

  await client.setFiles("#zipInput", [ZIP_FIXTURE]);
  await waitFor(
    () =>
      client.evaluate(
        '(() => { try { const payload = JSON.parse(document.querySelector("#jsonOutput").value); return document.querySelector("#annotationWorkspaceView").hidden === false && document.querySelector("#projectName").textContent === "image-set" && document.querySelector("#projectSaveState").dataset.state === "saved" && payload.images.length === 3 && window.location.hash.startsWith("#/project/"); } catch (error) { return false; } })()',
      ),
    "project A to be created",
    45_000,
  );

  const projectAHash = await client.evaluate("window.location.hash");
  assert.match(projectAHash, /^#\/project\/[^/]+$/);
  const projectAKey = decodeURIComponent(projectAHash.slice("#/project/".length));
  assert.notEqual(projectAKey, "");
  const openedA = await readBusinessState(client);
  assert.equal(openedA.name, "image-set");
  assert.equal(openedA.position, "1 / 3");
  assert.deepEqual(openedA.paths, EXPECTED_PATHS);
  assert.deepEqual(openedA.statuses, ["unlabeled", "unlabeled", "unlabeled"]);
  const focusedWorkspaceVisibility = await client.evaluate(`(() => {
    const rectCount = (id) => document.querySelector("#" + id).getClientRects().length;
    const sourceControls = [
      "openImageButton",
      "openFolderButton",
      "openZipButton",
      "imageInput",
      "folderInput",
      "zipInput",
    ];
    const annotationControls = [
      "exitProjectButton",
      "needsReviewButton",
      "labelGrid",
      "imageQueueDisclosure",
      "annotationCanvas",
      "importAnnotationsButton",
      "exportAnnotationsButton",
    ];
    return {
      sourceRectCounts: Object.fromEntries(
        sourceControls.map((id) => [id, rectCount(id)])
      ),
      annotationRectCounts: Object.fromEntries(
        annotationControls.map((id) => [id, rectCount(id)])
      ),
    };
  })()`);
  assert.equal(
    Object.values(focusedWorkspaceVisibility.sourceRectCounts).every((count) => count === 0),
    true,
  );
  assert.equal(
    Object.values(focusedWorkspaceVisibility.annotationRectCounts).every((count) => count > 0),
    true,
  );

  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await waitFor(
    () => client.evaluate("window.innerWidth === 390 && window.innerHeight === 844"),
    "the 390 by 844 workspace viewport",
  );
  const mobileScrollPlan = await client.evaluate(`(() => {
    const sidebar = document.querySelector(".sidebar");
    const header = document.querySelector(".workspace-project-header");
    const maximumScroll = document.documentElement.scrollHeight - window.innerHeight;
    const maximumStickyScroll =
      sidebar.offsetTop + sidebar.offsetHeight - header.offsetHeight - 1;
    const targetScroll = Math.max(
      1,
      Math.min(
        Math.floor(maximumScroll / 2),
        Math.floor(maximumStickyScroll / 2),
      ),
    );
    window.scrollTo(0, targetScroll);
    return { maximumScroll, maximumStickyScroll, targetScroll };
  })()`);
  await waitFor(
    () =>
      client.evaluate(
        `Math.abs(window.scrollY - ${JSON.stringify(mobileScrollPlan.targetScroll)}) <= 1`,
      ),
    "the mobile workspace to scroll",
  );
  assert.equal(mobileScrollPlan.maximumScroll > 0, true);
  assert.equal(mobileScrollPlan.maximumStickyScroll > 0, true);
  const mobileWorkspaceEvidence = await client.evaluate(`(() => {
    const header = document.querySelector(".workspace-project-header");
    const exitButton = document.querySelector("#exitProjectButton");
    const headerBounds = header.getBoundingClientRect();
    const exitBounds = exitButton.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollY: window.scrollY,
      headerTop: headerBounds.top,
      exitTop: exitBounds.top,
      exitBottom: exitBounds.bottom,
      exitDisplay: getComputedStyle(exitButton).display,
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  })()`);
  assert.equal(mobileWorkspaceEvidence.viewportWidth, 390);
  assert.equal(mobileWorkspaceEvidence.viewportHeight, 844);
  assert.equal(mobileWorkspaceEvidence.scrollY > 0, true);
  assert.equal(Math.abs(mobileWorkspaceEvidence.headerTop) <= 1, true);
  assert.notEqual(mobileWorkspaceEvidence.exitDisplay, "none");
  assert.equal(mobileWorkspaceEvidence.exitTop >= 0, true);
  assert.equal(
    mobileWorkspaceEvidence.exitBottom <= mobileWorkspaceEvidence.viewportHeight,
    true,
  );
  assert.equal(mobileWorkspaceEvidence.horizontalOverflow, false);
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.evaluate("window.scrollTo(0, 0)");
  await waitFor(
    () => client.evaluate("window.innerWidth === 1440 && window.scrollY === 0"),
    "the restored desktop workspace viewport",
  );

  await client.evaluate('document.querySelector("#needsReviewButton").click()');
  await waitFor(
    () =>
      client.evaluate(
        '(() => { try { const payload = JSON.parse(document.querySelector("#jsonOutput").value); return payload.images[0].status === "needs_review" && document.querySelector("#projectSaveState").dataset.state === "saved"; } catch (error) { return false; } })()',
      ),
    "project A annotation status to save",
  );
  const storedAAfterSave = await readStoredState(client, projectAKey);
  assert.equal(storedAAfterSave.metadata.localProjectKey, projectAKey);
  assert.equal(storedAAfterSave.records[0].status, "needs_review");
  assert.equal(storedAAfterSave.assetIds.every(Boolean), true);

  await reloadPage(client);
  await waitFor(
    () =>
      client.evaluate(
        '(() => { try { const payload = JSON.parse(document.querySelector("#jsonOutput").value); return document.querySelector("#annotationWorkspaceView").hidden === false && document.querySelector("#projectName").textContent === "image-set" && payload.images[0].status === "needs_review" && document.querySelector("#projectSaveState").dataset.state === "saved"; } catch (error) { return false; } })()',
      ),
    "project A after a hash-preserving refresh",
    30_000,
  );
  assert.equal(await client.evaluate("window.location.hash"), projectAHash);

  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDirectory,
  });
  await client.evaluate('document.querySelector("#exportAnnotationsButton").click()');
  const downloadedAnnotationPath = await waitFor(() => {
    const files = readdirSync(downloadDirectory).filter(
      (name) =>
        name.endsWith(".face-contour-annotations.json") &&
        !name.endsWith(".crdownload"),
    );
    return files.length === 1 ? join(downloadDirectory, files[0]) : null;
  }, "project A annotation export");
  const downloadedAnnotations = JSON.parse(
    readFileSync(downloadedAnnotationPath, "utf8"),
  );
  const serializedAnnotations = JSON.stringify(downloadedAnnotations);
  assert.equal(downloadedAnnotations.kind, "face-contour-annotations");
  assert.deepEqual(
    downloadedAnnotations.images.map((image) => image.relativePath),
    EXPECTED_PATHS,
  );
  assert.equal(downloadedAnnotations.images[0].status, "needs_review");
  [
    "localProjectKey",
    "localWriteToken",
    "projectId",
    "data:image",
    projectAKey,
    storedAAfterSave.metadata.localWriteToken,
    ...storedAAfterSave.metadata.images.map((image) => image.id),
  ].forEach((forbidden) => {
    assert.equal(serializedAnnotations.includes(forbidden), false, forbidden);
  });

  await client.evaluate(
    '(() => { window.__annotationConfirmMessages = []; window.confirm = (message) => { window.__annotationConfirmMessages.push(String(message)); return true; }; })()',
  );
  await client.setFiles("#annotationFileInput", [PARTIAL_ANNOTATIONS_FIXTURE]);
  await waitFor(
    () =>
      client.evaluate(
        '(() => { try { const payload = JSON.parse(document.querySelector("#jsonOutput").value); return payload.images[0].status === "skipped" && document.querySelector("#statusText").textContent.includes("1 image updated") && document.querySelector("#projectSaveState").dataset.state === "saved"; } catch (error) { return false; } })()',
      ),
    "project A annotation import",
    30_000,
  );
  const importEvidence = await client.evaluate(
    '(() => ({ confirmMessages: window.__annotationConfirmMessages, summary: document.querySelector("#annotationImportSummary").textContent.trim(), preview: document.querySelector("#jsonOutput").value }))()',
  );
  assert.equal(importEvidence.confirmMessages.length, 1);
  assert.match(importEvidence.confirmMessages[0], /replace existing work on 1 matching image/i);
  assert.equal(importEvidence.summary, "1 applied · 1 unmatched · 1 conflicts");
  assert.equal(importEvidence.preview.includes("localProjectKey"), false);
  const storedABeforeFailedAutosave = await readStoredState(client, projectAKey);
  assert.equal(storedABeforeFailedAutosave.records[0].status, "skipped");

  await client.evaluate(`(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put");
    window.__autosavePutDescriptor = descriptor;
    window.__autosavePutFailureCount = 0;
    Object.defineProperty(IDBObjectStore.prototype, "put", {
      ...descriptor,
      value(value, key) {
        if (
          window.__autosavePutFailureCount === 0 &&
          this.name === "project-images"
        ) {
          window.__autosavePutFailureCount += 1;
          throw new Error("Forced project image autosave failure.");
        }
        return descriptor.value.call(this, value, key);
      },
    });
  })()`);
  await client.evaluate('document.querySelector("#needsReviewButton").click()');
  await waitFor(
    () =>
      client.evaluate(
        '(() => { try { const payload = JSON.parse(document.querySelector("#jsonOutput").value); return payload.images[0].status === "needs_review" && document.querySelector("#projectSaveState").dataset.state === "failed" && document.querySelector("#statusText").textContent.includes("Local save failed"); } catch (error) { return false; } })()',
      ),
    "the forced project A autosave failure",
    30_000,
  );
  const autosavePutFailureCount = await client.evaluate(`(() => {
    const count = window.__autosavePutFailureCount;
    Object.defineProperty(
      IDBObjectStore.prototype,
      "put",
      window.__autosavePutDescriptor
    );
    delete window.__autosavePutDescriptor;
    return count;
  })()`);
  assert.equal(autosavePutFailureCount, 1);
  assert.deepEqual(await readStoredState(client, projectAKey), storedABeforeFailedAutosave);
  await client.evaluate(`(() => {
    window.__failedExitConfirmMessages = [];
    window.__allowFailedExit = false;
    window.confirm = (message) => {
      window.__failedExitConfirmMessages.push(String(message));
      return window.__allowFailedExit;
    };
  })()`);
  await client.evaluate('document.querySelector("#exitProjectButton").click()');
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#annotationWorkspaceView").hidden === false && document.querySelector("#statusText").textContent.includes("Exit cancelled") && document.querySelector("#exitProjectButton").disabled === false',
      ),
    "project A to remain open after cancelling the failed-save exit",
  );
  assert.equal(await client.evaluate("window.location.hash"), projectAHash);
  assert.equal(
    await client.evaluate(
      'JSON.parse(document.querySelector("#jsonOutput").value).images[0].status',
    ),
    "needs_review",
  );
  assert.deepEqual(await readStoredState(client, projectAKey), storedABeforeFailedAutosave);
  const cancelledFailedExitMessages = await client.evaluate(
    "window.__failedExitConfirmMessages",
  );
  assert.equal(cancelledFailedExitMessages.length, 1);
  assert.match(cancelledFailedExitMessages[0], /not saved.*Exit anyway.*abandon/i);

  await client.evaluate("window.__allowFailedExit = true");
  await client.evaluate('document.querySelector("#exitProjectButton").click()');
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectHubView").hidden === false && document.querySelector("#projectLibraryCount").textContent.trim() === "1 project" && document.querySelector("#hubStatusText").textContent.includes("Exited without the unsaved in-memory changes") && window.location.hash === ""',
      ),
    "project A to explicitly abandon the failed autosave and exit",
  );
  const abandonedFailedExitMessages = await client.evaluate(
    "window.__failedExitConfirmMessages",
  );
  assert.equal(abandonedFailedExitMessages.length, 2);
  assert.deepEqual(await readStoredState(client, projectAKey), storedABeforeFailedAutosave);
  const hubAfterA = await readHubState(client);
  assert.deepEqual(hubAfterA.names, ["image-set"]);
  assert.match(hubAfterA.progress[0], /1 skipped/);
  assert.equal(hubAfterA.workspaceHidden, true);

  await client.setFiles("#zipInput", [boundedWorkerZip]);
  await waitFor(
    () =>
      client.evaluate(
        '(() => { try { const payload = JSON.parse(document.querySelector("#jsonOutput").value); return document.querySelector("#annotationWorkspaceView").hidden === false && document.querySelector("#projectName").textContent === "bounded-workers" && payload.images.length === 8 && document.querySelector("#projectSaveState").dataset.state === "saved"; } catch (error) { return false; } })()',
      ),
    "project B to be created",
    60_000,
  );
  const projectBHash = await client.evaluate("window.location.hash");
  const projectBKey = decodeURIComponent(projectBHash.slice("#/project/".length));
  assert.notEqual(projectBKey, projectAKey);
  await client.evaluate('document.querySelector("#needsReviewButton").click()');
  await waitFor(
    () =>
      client.evaluate(
        '(() => { try { const payload = JSON.parse(document.querySelector("#jsonOutput").value); return payload.images[0].status === "needs_review" && document.querySelector("#projectSaveState").dataset.state === "saved"; } catch (error) { return false; } })()',
      ),
    "project B annotation status to save",
  );

  const storedAWhileBIsOpen = await readStoredState(client, projectAKey);
  const storedB = await readStoredState(client, projectBKey);
  assert.equal(storedAWhileBIsOpen.records[0].status, "skipped");
  assert.equal(storedAWhileBIsOpen.records.length, 3);
  assert.equal(storedB.records[0].status, "needs_review");
  assert.equal(storedB.records.length, 8);
  const projectBImageId = storedB.metadata.images[0].id;
  const staleDeletedProjectSetup = await client.evaluate(`(async () => {
    const storage = await import("/src/storage.js?v=browser-stale-deleted-project-setup");
    const project = await storage.getLocalProject(${JSON.stringify(projectBKey)});
    const imageId = project.images[0].id;
    const record = await storage.getLocalProjectImageRecord(project.localProjectKey, imageId);
    const asset = await storage.getLocalProjectImageAsset(project.localProjectKey, imageId);
    window.__staleDeletedProject = structuredClone(project);
    window.__staleDeletedImage = {
      ...structuredClone(record),
      dataUrl: asset.dataUrl,
      status: "skipped",
      updatedAt: new Date().toISOString(),
    };
    return {
      imageId,
      localProjectKey: project.localProjectKey,
      localWriteToken: project.localWriteToken,
      hasDataUrl: window.__staleDeletedImage.dataUrl.startsWith("data:image/"),
    };
  })()`);
  assert.equal(staleDeletedProjectSetup.imageId, projectBImageId);
  assert.equal(staleDeletedProjectSetup.localProjectKey, projectBKey);
  assert.equal(staleDeletedProjectSetup.localWriteToken, storedB.metadata.localWriteToken);
  assert.equal(staleDeletedProjectSetup.hasDataUrl, true);

  await client.evaluate('document.querySelector("#exitProjectButton").click()');
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectHubView").hidden === false && document.querySelector("#projectLibraryCount").textContent.trim() === "2 projects"',
      ),
    "both projects in the hub",
  );
  const twoProjectHub = await readHubState(client);
  assert.deepEqual(new Set(twoProjectHub.names), new Set(["image-set", "bounded-workers"]));
  assert.deepEqual(await readProjectStoreCounts(client), {
    projects: 2,
    records: 11,
    assets: 11,
  });

  const countsBeforeFailedCreate = await readProjectStoreCounts(client);
  await client.evaluate(
    '(() => { const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "add"); window.__projectCreateAddDescriptor = descriptor; window.__projectCreateFailureCount = 0; Object.defineProperty(IDBObjectStore.prototype, "add", { ...descriptor, value(value, key) { if (window.__projectCreateFailureCount === 0 && this.name === "project-image-assets") { window.__projectCreateFailureCount += 1; throw new Error("Forced local project creation failure."); } return descriptor.value.call(this, value, key); } }); })()',
  );
  await client.setFiles("#imageInput", [SOURCE_REPLACEMENT_IMAGE]);
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#hubStatusText").textContent.includes("Forced local project creation failure")',
      ),
    "the atomic project creation failure",
    30_000,
  );
  const creationFailureCount = await client.evaluate(
    '(() => { const count = window.__projectCreateFailureCount; Object.defineProperty(IDBObjectStore.prototype, "add", window.__projectCreateAddDescriptor); delete window.__projectCreateAddDescriptor; return count; })()',
  );
  assert.equal(creationFailureCount, 1);
  assert.deepEqual(await readProjectStoreCounts(client), countsBeforeFailedCreate);
  assert.deepEqual(
    new Set((await readStoredProjects(client)).map((project) => project.name)),
    new Set(["image-set", "bounded-workers"]),
  );
  assert.equal((await readHubState(client)).countLabel, "2 projects");

  await clickProjectCardAction(client, "image-set", ".open-project-button");
  await waitFor(
    () =>
      client.evaluate(
        '(() => { try { const payload = JSON.parse(document.querySelector("#jsonOutput").value); return document.querySelector("#projectName").textContent === "image-set" && payload.images.length === 3 && payload.images[0].status === "skipped"; } catch (error) { return false; } })()',
      ),
    "project A to reopen",
    30_000,
  );
  assert.equal(await client.evaluate("window.location.hash"), projectAHash);
  assert.equal((await readStoredState(client, projectBKey)).records[0].status, "needs_review");

  await client.evaluate('document.querySelector("#exitProjectButton").click()');
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectHubView").hidden === false && document.querySelector("#projectLibraryCount").textContent.trim() === "2 projects"',
      ),
    "the hub before deletion",
  );

  await client.evaluate(
    '(() => { window.__deleteConfirmMessages = []; window.confirm = (message) => { window.__deleteConfirmMessages.push(String(message)); return false; }; })()',
  );
  await clickProjectCardAction(client, "bounded-workers", ".delete-project-button");
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#hubStatusText").textContent.includes("Project deletion cancelled")',
      ),
    "project B deletion cancellation",
  );
  assert.equal((await readHubState(client)).countLabel, "2 projects");
  const deleteConfirmMessages = await client.evaluate("window.__deleteConfirmMessages");
  assert.equal(deleteConfirmMessages.length, 1);
  assert.match(deleteConfirmMessages[0], /Original files and exported JSON are not affected/i);
  assert.notEqual(await readStoredState(client, projectBKey), null);

  const countsBeforeDelete = await readProjectStoreCounts(client);
  const storedABeforeFailedDelete = await readStoredState(client, projectAKey);
  const storedBBeforeFailedDelete = await readStoredState(client, projectBKey);
  const rawABeforeFailedDelete = await readRawProjectStorageEntry(client, {
    localProjectKey: projectAKey,
    imageId: storedABeforeFailedDelete.metadata.images[0].id,
  });
  const rawBBeforeFailedDelete = await readRawProjectStorageEntry(client, {
    localProjectKey: projectBKey,
    imageId: projectBImageId,
  });
  await client.evaluate(`(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "delete");
    window.__projectDeleteDescriptor = descriptor;
    window.__projectDeleteFailureCount = 0;
    Object.defineProperty(IDBObjectStore.prototype, "delete", {
      ...descriptor,
      value(key) {
        if (
          window.__projectDeleteFailureCount === 0 &&
          this.name === "project-image-assets" &&
          key === ${JSON.stringify(projectBImageId)}
        ) {
          window.__projectDeleteFailureCount += 1;
          throw new Error("Forced local project asset deletion failure.");
        }
        return descriptor.value.call(this, key);
      },
    });
    window.confirm = () => true;
  })()`);
  await clickProjectCardAction(client, "bounded-workers", ".delete-project-button");
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#hubStatusText").textContent.includes("Project could not be deleted. Its local copy was kept") && Array.from(document.querySelectorAll(".delete-project-button")).every((button) => button.disabled === false)',
      ),
    "the rolled-back project B deletion failure",
    30_000,
  );
  const projectDeleteFailureCount = await client.evaluate(`(() => {
    const count = window.__projectDeleteFailureCount;
    Object.defineProperty(
      IDBObjectStore.prototype,
      "delete",
      window.__projectDeleteDescriptor
    );
    delete window.__projectDeleteDescriptor;
    return count;
  })()`);
  assert.equal(projectDeleteFailureCount, 1);
  assert.equal((await readHubState(client)).countLabel, "2 projects");
  assert.deepEqual(
    new Set((await readHubState(client)).names),
    new Set(["image-set", "bounded-workers"]),
  );
  assert.deepEqual(await readProjectStoreCounts(client), countsBeforeDelete);
  assert.deepEqual(await readStoredState(client, projectAKey), storedABeforeFailedDelete);
  assert.deepEqual(await readStoredState(client, projectBKey), storedBBeforeFailedDelete);
  assert.deepEqual(
    await readRawProjectStorageEntry(client, {
      localProjectKey: projectAKey,
      imageId: storedABeforeFailedDelete.metadata.images[0].id,
    }),
    rawABeforeFailedDelete,
  );
  assert.deepEqual(
    await readRawProjectStorageEntry(client, {
      localProjectKey: projectBKey,
      imageId: projectBImageId,
    }),
    rawBBeforeFailedDelete,
  );

  await client.evaluate("window.confirm = () => true");
  await clickProjectCardAction(client, "bounded-workers", ".delete-project-button");
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectLibraryCount").textContent.trim() === "1 project" && document.querySelector("#hubStatusText").textContent.includes("Deleted the local copy of bounded-workers")',
      ),
    "project B deletion",
    30_000,
  );
  const countsAfterDelete = await readProjectStoreCounts(client);
  assert.deepEqual(countsAfterDelete, {
    projects: countsBeforeDelete.projects - 1,
    records: countsBeforeDelete.records - 8,
    assets: countsBeforeDelete.assets - 8,
  });
  assert.equal(await readStoredState(client, projectBKey), null);
  const staleDeletedWriteEvidence = await client.evaluate(`(async () => {
    const storage = await import("/src/storage.js?v=browser-stale-deleted-project-write");
    const captureErrorCode = async (write) => {
      try {
        await write();
        return null;
      } catch (error) {
        return error?.code || null;
      }
    };
    const snapshotErrorCode = await captureErrorCode(() =>
      storage.putLocalProjectSnapshot({
        project: window.__staleDeletedProject,
        image: window.__staleDeletedImage,
      })
    );
    const assetErrorCode = await captureErrorCode(() =>
      storage.putLocalProjectImageAsset({
        project: window.__staleDeletedProject,
        image: window.__staleDeletedImage,
      })
    );
    return {
      snapshotErrorCode,
      assetErrorCode,
      deletedProject: await storage.getLocalProject(
        window.__staleDeletedProject.localProjectKey
      ),
      projects: (await storage.listLocalProjects()).map((project) => ({
        localProjectKey: project.localProjectKey,
        name: project.name,
      })),
    };
  })()`);
  assert.equal(staleDeletedWriteEvidence.snapshotErrorCode, "LOCAL_PROJECT_DELETED");
  assert.equal(staleDeletedWriteEvidence.assetErrorCode, "LOCAL_PROJECT_DELETED");
  assert.equal(staleDeletedWriteEvidence.deletedProject, null);
  assert.deepEqual(staleDeletedWriteEvidence.projects, [
    { localProjectKey: projectAKey, name: "image-set" },
  ]);
  const deletedProjectBRawState = await readRawProjectStorageEntry(client, {
    localProjectKey: projectBKey,
    imageId: projectBImageId,
  });
  assert.equal(deletedProjectBRawState.metadata, null);
  assert.equal(deletedProjectBRawState.record, null);
  assert.equal(deletedProjectBRawState.asset, null);
  assert.deepEqual(await readProjectStoreCounts(client), countsAfterDelete);
  const storedAAfterRejectedDeletedWrites = await readStoredState(client, projectAKey);
  assert.equal(storedAAfterRejectedDeletedWrites.records.length, 3);
  assert.equal(storedAAfterRejectedDeletedWrites.records[0].status, "skipped");

  await clickProjectCardAction(client, "image-set", ".open-project-button");
  await waitFor(
    () =>
      client.evaluate(
        '(() => { try { const payload = JSON.parse(document.querySelector("#jsonOutput").value); return document.querySelector("#projectName").textContent === "image-set" && payload.images[0].status === "skipped"; } catch (error) { return false; } })()',
      ),
    "project A after project B deletion",
  );
  await client.evaluate('document.querySelector("#exitProjectButton").click()');
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectHubView").hidden === false && window.location.hash === ""',
      ),
    "the final project hub",
  );

  await client.evaluate('window.location.hash = "#/not-a-valid-route"');
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectHubView").hidden === false && window.location.hash === "" && document.querySelector("#hubStatusText").textContent.includes("not valid")',
      ),
    "an invalid hash to fail closed to the hub",
  );
  const invalidRouteHub = await readHubState(client);
  assert.equal(invalidRouteHub.countLabel, "1 project");
  assert.deepEqual(invalidRouteHub.names, ["image-set"]);

  const countsBeforeRouteGuardCreate = await readProjectStoreCounts(client);
  await client.evaluate(`(() => {
    const storageManager = navigator.storage;
    window.__routeGuardEstimateHadOwn = Object.prototype.hasOwnProperty.call(
      storageManager,
      "estimate"
    );
    window.__routeGuardEstimateDescriptor = Object.getOwnPropertyDescriptor(
      storageManager,
      "estimate"
    );
    window.__routeGuardEstimateRequestCount = 0;
    window.__routeGuardEstimateReleaseCount = 0;
    window.__releaseRouteGuardEstimate = null;
    Object.defineProperty(storageManager, "estimate", {
      configurable: true,
      writable: true,
      value() {
        window.__routeGuardEstimateRequestCount += 1;
        return new Promise((resolveEstimate) => {
          let released = false;
          window.__releaseRouteGuardEstimate = () => {
            if (released) {
              return;
            }
            released = true;
            window.__routeGuardEstimateReleaseCount += 1;
            resolveEstimate({ usage: 0, quota: 1024 ** 4 });
          };
        });
      },
    });
  })()`);
  await client.setFiles("#imageInput", [SOURCE_REPLACEMENT_IMAGE]);
  await waitFor(
    () =>
      client.evaluate(
        'window.__routeGuardEstimateRequestCount === 1 && typeof window.__releaseRouteGuardEstimate === "function" && Array.from(document.querySelectorAll(".project-card button")).every((button) => button.disabled)',
      ),
    "the new project import to pause at its storage estimate",
  );
  assert.deepEqual(await readProjectStoreCounts(client), countsBeforeRouteGuardCreate);
  await client.evaluate(`(() => {
    window.__routeGuardHashChangeCount = 0;
    window.__routeGuardHashChangeHandler = () => {
      window.__routeGuardHashChangeCount += 1;
    };
    window.addEventListener("hashchange", window.__routeGuardHashChangeHandler);
    window.location.hash = ${JSON.stringify(projectAHash)};
  })()`);
  await waitFor(
    () =>
      client.evaluate(
        `window.location.hash === ${JSON.stringify(projectAHash)} && window.__routeGuardHashChangeCount >= 1`,
      ),
    "project A navigation while project creation is paused",
  );
  await client.evaluate("window.__releaseRouteGuardEstimate()");
  await waitFor(
    () =>
      client.evaluate(
        `(() => { try { const payload = JSON.parse(document.querySelector("#jsonOutput").value); return document.querySelector("#annotationWorkspaceView").hidden === false && document.querySelector("#projectName").textContent === "image-set" && payload.images[0].status === "skipped" && window.location.hash === ${JSON.stringify(projectAHash)}; } catch (error) { return false; } })()`,
      ),
    "project A to retain the visible route after background project creation",
    45_000,
  );
  const routeGuardEstimateEvidence = await client.evaluate(`(() => {
    window.removeEventListener("hashchange", window.__routeGuardHashChangeHandler);
    const evidence = {
      requestCount: window.__routeGuardEstimateRequestCount,
      releaseCount: window.__routeGuardEstimateReleaseCount,
      hashChangeCount: window.__routeGuardHashChangeCount,
    };
    if (window.__routeGuardEstimateHadOwn) {
      Object.defineProperty(
        navigator.storage,
        "estimate",
        window.__routeGuardEstimateDescriptor
      );
    } else {
      delete navigator.storage.estimate;
    }
    delete window.__routeGuardHashChangeHandler;
    delete window.__routeGuardEstimateDescriptor;
    delete window.__releaseRouteGuardEstimate;
    return evidence;
  })()`);
  assert.equal(routeGuardEstimateEvidence.requestCount, 1);
  assert.equal(routeGuardEstimateEvidence.releaseCount, 1);
  assert.equal(routeGuardEstimateEvidence.hashChangeCount >= 1, true);
  const projectsAfterRouteGuardCreate = await readStoredProjects(client);
  assert.equal(projectsAfterRouteGuardCreate.length, 2);
  const routeGuardProject = projectsAfterRouteGuardCreate.find(
    (project) => project.localProjectKey !== projectAKey,
  );
  assert.equal(routeGuardProject.name, "face-lena.jpg");
  const routeGuardProjectState = await readStoredState(
    client,
    routeGuardProject.localProjectKey,
  );
  assert.equal(routeGuardProjectState.records.length, 1);
  assert.equal(routeGuardProjectState.records[0].status, "unlabeled");
  assert.equal(routeGuardProjectState.assetIds.every(Boolean), true);
  assert.deepEqual(await readProjectStoreCounts(client), {
    projects: countsBeforeRouteGuardCreate.projects + 1,
    records: countsBeforeRouteGuardCreate.records + 1,
    assets: countsBeforeRouteGuardCreate.assets + 1,
  });

  await client.evaluate('document.querySelector("#exitProjectButton").click()');
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectHubView").hidden === false && document.querySelector("#projectLibraryCount").textContent.trim() === "2 projects" && window.location.hash === ""',
      ),
    "the hub after the guarded project creation",
  );
  const routeGuardProjectExpectedHash =
    "#/project/" + encodeURIComponent(routeGuardProject.localProjectKey);
  await clickProjectCardAction(client, "face-lena.jpg", ".open-project-button");
  await waitFor(
    () =>
      client.evaluate(
        `document.querySelector("#annotationWorkspaceView").hidden === false && document.querySelector("#projectName").textContent === "face-lena.jpg" && window.location.hash === ${JSON.stringify(routeGuardProjectExpectedHash)}`,
      ),
    "the project created during the route race to open from the hub",
  );
  const routeGuardProjectHash = await client.evaluate("window.location.hash");
  assert.notEqual(routeGuardProjectHash, projectAHash);
  await client.evaluate(`(() => {
    document.querySelector("#needsReviewButton").click();
    document.querySelector("#exitProjectButton").click();
    window.location.hash = ${JSON.stringify(projectAHash)};
  })()`);
  await waitFor(
    () =>
      client.evaluate(
        `(() => { try { const payload = JSON.parse(document.querySelector("#jsonOutput").value); return document.querySelector("#annotationWorkspaceView").hidden === false && document.querySelector("#projectName").textContent === "image-set" && payload.images[0].status === "skipped" && window.location.hash === ${JSON.stringify(projectAHash)}; } catch (error) { return false; } })()`,
      ),
    "project A to own navigation during the other project's pending exit save",
    30_000,
  );
  assert.equal(
    (await readStoredState(client, routeGuardProject.localProjectKey)).records[0].status,
    "needs_review",
  );
  await client.evaluate('document.querySelector("#exitProjectButton").click()');
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectHubView").hidden === false && document.querySelector("#projectLibraryCount").textContent.trim() === "2 projects" && window.location.hash === ""',
      ),
    "the hub before the cross-tab deletion switch test",
  );

  await client.setFiles("#zipInput", [boundedWorkerZip]);
  await waitFor(
    () =>
      client.evaluate(
        '(() => { try { const payload = JSON.parse(document.querySelector("#jsonOutput").value); return document.querySelector("#annotationWorkspaceView").hidden === false && document.querySelector("#projectName").textContent === "bounded-workers" && payload.images.length === 8 && document.querySelector("#projectSaveState").dataset.state === "saved"; } catch (error) { return false; } })()',
      ),
    "the temporary multi-image project for cross-tab deletion",
    60_000,
  );
  const crossTabDeletedProjectHash = await client.evaluate("window.location.hash");
  const crossTabDeletedProjectKey = decodeURIComponent(
    crossTabDeletedProjectHash.slice("#/project/".length),
  );
  const crossTabSwitchBusinessBefore = await readBusinessState(client);
  const crossTabSwitchJsonBefore = await client.evaluate(
    'document.querySelector("#jsonOutput").value',
  );
  const crossTabSwitchFileMetaBefore = await client.evaluate(
    'document.querySelector("#fileMeta").textContent',
  );
  await client.evaluate(`(() => {
    window.__switchUnhandledRejections = [];
    window.__switchUnhandledRejectionHandler = (event) => {
      window.__switchUnhandledRejections.push(
        String(event.reason?.message || event.reason || "Unknown rejection")
      );
    };
    window.addEventListener(
      "unhandledrejection",
      window.__switchUnhandledRejectionHandler
    );
  })()`);
  const switchRuntimeEventOffset = client.events.length;
  const crossTabDeleteResult = await client.evaluate(`(async () => {
    const storage = await import("/src/storage.js?v=browser-cross-tab-switch-delete");
    return storage.deleteLocalProject(${JSON.stringify(crossTabDeletedProjectKey)});
  })()`);
  assert.equal(crossTabDeleteResult, true);
  assert.equal(await readStoredState(client, crossTabDeletedProjectKey), null);
  await client.evaluate('document.querySelector("#nextImageButton").click()');
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#statusText").textContent.includes("deleted in another tab") && document.querySelector("#statusText").textContent.includes("Export this tab\'s annotations now") && document.querySelector("#projectSaveState").dataset.state === "failed" && document.querySelector("#projectSaveState").textContent.toLowerCase().includes("export annotations now")',
      ),
    "the readable deleted-project error after Next",
  );
  await client.evaluate("new Promise((resolveDelay) => setTimeout(resolveDelay, 100))");
  const crossTabSwitchBusinessAfter = await readBusinessState(client);
  const crossTabSwitchUnhandledRejections = await client.evaluate(`(() => {
    window.removeEventListener(
      "unhandledrejection",
      window.__switchUnhandledRejectionHandler
    );
    return window.__switchUnhandledRejections;
  })()`);
  assert.deepEqual(crossTabSwitchBusinessAfter, crossTabSwitchBusinessBefore);
  assert.equal(
    await client.evaluate('document.querySelector("#jsonOutput").value'),
    crossTabSwitchJsonBefore,
  );
  assert.equal(
    await client.evaluate('document.querySelector("#fileMeta").textContent'),
    crossTabSwitchFileMetaBefore,
  );
  assert.deepEqual(crossTabSwitchUnhandledRejections, []);
  assert.equal(
    client.events
      .slice(switchRuntimeEventOffset)
      .some((event) => event.method === "Runtime.exceptionThrown"),
    false,
  );

  await client.evaluate(`(() => {
    window.__crossTabExitConfirmMessages = [];
    window.__allowCrossTabExit = false;
    window.confirm = (message) => {
      window.__crossTabExitConfirmMessages.push(String(message));
      return window.__allowCrossTabExit;
    };
  })()`);
  await client.evaluate('document.querySelector("#exitProjectButton").click()');
  await waitFor(
    () =>
      client.evaluate(
        `document.querySelector("#annotationWorkspaceView").hidden === false && document.querySelector("#projectName").textContent === "bounded-workers" && document.querySelector("#projectSaveState").dataset.state === "failed" && document.querySelector("#statusText").textContent.includes("Exit cancelled") && document.querySelector("#exitProjectButton").disabled === false && window.location.hash === ${JSON.stringify(crossTabDeletedProjectHash)}`,
      ),
    "the cross-tab deleted project to remain open after exit cancellation",
  );
  assert.equal(
    await client.evaluate('document.querySelector("#jsonOutput").value'),
    crossTabSwitchJsonBefore,
  );
  const cancelledCrossTabExitMessages = await client.evaluate(
    "window.__crossTabExitConfirmMessages",
  );
  assert.equal(cancelledCrossTabExitMessages.length, 1);
  assert.match(
    cancelledCrossTabExitMessages[0],
    /not saved.*Export annotation JSON.*Exit anyway.*abandon/i,
  );

  await client.evaluate("window.__allowCrossTabExit = true");
  await client.evaluate('document.querySelector("#exitProjectButton").click()');
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectHubView").hidden === false && document.querySelector("#projectLibraryCount").textContent.trim() === "2 projects" && document.querySelector("#hubStatusText").textContent.includes("Exited without the unsaved in-memory changes") && window.location.hash === ""',
      ),
    "the hub after explicitly abandoning the cross-tab deleted project",
  );
  assert.equal(
    (await client.evaluate("window.__crossTabExitConfirmMessages")).length,
    2,
  );
  await client.evaluate("window.confirm = () => true");
  await clickProjectCardAction(client, "face-lena.jpg", ".delete-project-button");
  await waitFor(
    () =>
      client.evaluate(
        'document.querySelector("#projectLibraryCount").textContent.trim() === "1 project" && document.querySelector("#hubStatusText").textContent.includes("Deleted the local copy of face-lena.jpg")',
      ),
    "the route-race project cleanup",
    30_000,
  );
  assert.deepEqual((await readHubState(client)).names, ["image-set"]);
  assert.deepEqual(await readProjectStoreCounts(client), {
    projects: 1,
    records: 3,
    assets: 3,
  });
  assert.deepEqual(
    await readStoredState(client, projectAKey),
    storedAAfterRejectedDeletedWrites,
  );

  console.log("browser local-project hub workflow test passed");
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
        console.warn(
          "Temporary browser profile could not be removed: " +
            relative(tmpdir(), profileDirectory),
        );
      } else {
        await delay(100);
      }
    }
  }
}
