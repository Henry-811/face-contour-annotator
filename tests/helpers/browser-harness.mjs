import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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


export { findChrome, delay, waitForChildExit, waitFor, startStaticServer, waitForDevTools, CdpClient };
