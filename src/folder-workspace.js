import { LABELS, MAX_IMAGE_SET_ENTRIES, MAX_ANNOTATION_FILE_BYTES, MIN_ANNOTATION_IMAGE_SIDE } from "./config.js?v=workspace-ux-2";
import { normalizeAnnotationRelativePath } from "./annotation-transfer.js?v=workspace-ux-2";
import { buildTaskSchema, normalizeImportedContours, serializeContours } from "./exporter.js?v=workspace-ux-2";
import { createAnnotationProject, createLocalProjectKey, isImageStatus } from "./project.js?v=workspace-ux-2";

export const FOLDER_PROJECT_PREFIX = "folder:";
export const FOLDER_IMAGE_KIND = "face-contour-folder-image";
export const FOLDER_MANIFEST = "face-contour-workspace.json";
export const FOLDER_SESSION = "face-contour-session.json";
export const FOLDER_BOOKMARK_DB = "face-contour-folder-bookmarks";
export const FOLDER_QUEUE_PAGE_SIZE = 50;
// Aggregate datasets can be large; bound individual image/JSON working buffers.
export const MAX_FOLDER_IMAGE_BYTES = 128 * 1024 * 1024;
export const MAX_FOLDER_IMAGE_PIXELS = 64 * 1024 * 1024;
const MAX_DRAFT_POINTS = 100000;
const IMAGE_EXTENSION = /\.(avif|bmp|gif|jpe?g|png|webp)$/i;
const WORKSPACE_KIND = "face-contour-folder-workspace";
const MANIFEST_INITIALIZATION_LOCK = "face-contour-folder:manifest-initialization";

export class FolderWorkspaceError extends Error {
  constructor({ code, message, cause }) {
    super(message, { cause });
    this.name = "FolderWorkspaceError";
    this.code = code;
  }
}

export function supportsFolderWorkspace() {
  return globalThis.isSecureContext && typeof globalThis.showDirectoryPicker === "function";
}

export async function ensureFolderPermission({ handle, mode, request = false }) {
  if (!handle || handle.kind !== "directory") {
    throw new FolderWorkspaceError({ code: "FOLDER_MISSING", message: "Choose the image and output folders again." });
  }
  let permission = await handle.queryPermission({ mode });
  if (permission !== "granted" && request) permission = await handle.requestPermission({ mode });
  if (permission !== "granted") {
    throw new FolderWorkspaceError({ code: "FOLDER_PERMISSION", message: "Folder permission is needed. Click Continue to reconnect, or choose both folders again." });
  }
}

async function fileTarget({ root, path, create = false }) {
  const parts = normalizeAnnotationRelativePath(path).split("/");
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create });
  return { directory, name: parts.at(-1) };
}

async function fileAt({ root, path, create = false }) {
  const { directory, name } = await fileTarget({ root, path, create });
  return directory.getFileHandle(name, { create });
}

async function readJson({ root, path }) {
  let handle;
  try {
    handle = await fileAt({ root, path });
  } catch (error) {
    // A missing annotation is a genuinely unvisited image, not a read failure.
    if (error.name === "NotFoundError") return null;
    throw error;
  }
  const file = await handle.getFile();
  if (file.size === 0) {
    throw new FolderWorkspaceError({
      code: "FOLDER_INVALID_JSON",
      message: `${path} is empty (0 bytes). Back up the output folder first. If this was left by a failed first save, move only this empty file outside the output folder, then reopen; otherwise restore its backup. No files were changed.`,
    });
  }
  if (file.size > MAX_ANNOTATION_FILE_BYTES) {
    throw new FolderWorkspaceError({ code: "FOLDER_INVALID_JSON", message: `${path} is too large to read safely.` });
  }
  const text = await file.text();
  try {
    return { text, data: JSON.parse(text) };
  } catch (error) {
    throw new FolderWorkspaceError({ code: "FOLDER_INVALID_JSON", message: `${path} is not valid JSON. Restore a backup; this file was not overwritten.` });
  }
}

async function writeJson({ root, path, data, expectedText }) {
  const text = JSON.stringify(data, null, 2);
  if (new Blob([text]).size > MAX_ANNOTATION_FILE_BYTES) {
    throw new FolderWorkspaceError({ code: "FOLDER_INVALID_JSON", message: "This annotation exceeds the per-file size limit. Download the current JSON before leaving." });
  }
  const { directory, name } = await fileTarget({ root, path, create: true });
  let handle;
  let created = false;
  try {
    handle = await directory.getFileHandle(name);
  } catch (error) {
    if (error.name !== "NotFoundError") throw error;
    if (expectedText !== null && expectedText !== undefined) {
      throw new FolderWorkspaceError({ code: "FOLDER_CONFLICT", message: `${path} was removed outside this session. Download current JSON before reopening; the missing file was not recreated.` });
    }
    // Callers hold the workspace lease, or the initialization lock for a new
    // manifest. No same-origin creator can enter this gap before cleanup ends.
    handle = await directory.getFileHandle(name, { create: true });
    created = true;
  }
  let stream;
  try {
    stream = await handle.createWritable({ mode: "exclusive" });
    const currentText = await (await handle.getFile()).text();
    if (currentText !== (expectedText ?? "")) {
      throw new FolderWorkspaceError({ code: "FOLDER_CONFLICT", message: `${path} changed outside this session. Download current JSON, then reopen the project; no existing annotations were overwritten.` });
    }
    await stream.write(text);
    await stream.close();
    return text;
  } catch (error) {
    let abortSucceeded = true;
    if (stream) {
      try {
        await stream.abort();
      } catch (abortError) {
        abortSucceeded = false;
        console.warn("Folder write abort failed.", { path, code: abortError.name });
      }
    }
    if (created) {
      try {
        // Do not delete a file whose stream may still be active or locked.
        if (!abortSucceeded || error.name === "NoModificationAllowedError") throw error;
        const currentHandle = await directory.getFileHandle(name);
        if (await currentHandle.isSameEntry(handle) && (await currentHandle.getFile()).size === 0) {
          await directory.removeEntry(name);
          console.warn("Removed empty file after failed first write.", { path, code: error.name });
        }
      } catch (cleanupError) {
        // An already-removed entry needs no cleanup. Anything else must stay
        // visible; the user may need to restore permissions or recover manually.
        if (cleanupError.name !== "NotFoundError") {
          console.warn("Failed first-write recovery needs attention.", { path, code: cleanupError.name });
          throw new FolderWorkspaceError({
            code: "FOLDER_WRITE_RECOVERY",
            message: `Saving ${path} failed and cleanup could not be confirmed. Download current JSON before leaving. Restore folder access and retry; if reopening reports an empty file, back up the output folder and move only that 0-byte file outside it.`,
            cause: error,
          });
        }
      }
    }
    throw error;
  }
}

export async function scanImageDirectory(root) {
  const sources = [];
  const pending = [{ handle: root, prefix: "" }];
  const paths = new Set();
  while (pending.length) {
    const { handle, prefix } = pending.pop();
    for await (const [name, entry] of handle.entries()) {
      const rawPath = `${prefix}${name}`;
      if (entry.kind === "directory") {
        pending.push({ handle: entry, prefix: `${rawPath}/` });
      } else if (IMAGE_EXTENSION.test(name)) {
        const path = normalizeAnnotationRelativePath(rawPath);
        // Normalization must not change the filesystem lookup used for sidecars.
        if (paths.has(path.toLowerCase())) throw new FolderWorkspaceError({ code: "FOLDER_DUPLICATE", message: `Duplicate image path: ${path}.` });
        paths.add(path.toLowerCase());
        sources.push({ path, name, handle: entry });
        if (sources.length > MAX_IMAGE_SET_ENTRIES) throw new FolderWorkspaceError({ code: "FOLDER_LIMIT", message: `A workspace supports up to ${MAX_IMAGE_SET_ENTRIES} images.` });
      }
    }
  }
  if (!sources.length) throw new FolderWorkspaceError({ code: "FOLDER_EMPTY", message: "No supported images were found. Choose a folder containing images." });
  sources.sort((left, right) => left.path.localeCompare(right.path, "en", { numeric: true, sensitivity: "base" }));
  // Reject a file-vs-directory collision in the mirrored sidecar layout.
  const outputPaths = new Set(sources.map(({ path }) => `${path}.json`.toLowerCase()));
  for (const { path } of sources) {
    const parts = path.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i += 1) {
      if (outputPaths.has(parts.slice(0, i).join("/"))) throw new FolderWorkspaceError({ code: "FOLDER_DUPLICATE", message: `Conflicting annotation output path: ${path}.` });
    }
  }
  return sources;
}

function annotationPath(path) {
  return `annotations/${normalizeAnnotationRelativePath(path)}.json`;
}

export function validateFolderImage({ data, path }) {
  if (data?.kind !== FOLDER_IMAGE_KIND || ![1, 2].includes(data.version) || data.relativePath !== path ||
      !Number.isInteger(data.width) || !Number.isInteger(data.height) ||
      data.width < MIN_ANNOTATION_IMAGE_SIDE || data.height < MIN_ANNOTATION_IMAGE_SIDE ||
      data.width * data.height > MAX_FOLDER_IMAGE_PIXELS || !isImageStatus(data.status) ||
      !Number.isSafeInteger(data.source?.size) || data.source.size < 1 ||
      !/^[a-f0-9]{64}$/.test(data.source?.sha256 || "") ||
      typeof data.revision !== "string" || !data.revision) {
    throw new FolderWorkspaceError({ code: "FOLDER_INVALID_RECORD", message: `Invalid or mismatched annotation for ${path}. The saved file was kept.` });
  }
  const contours = normalizeImportedContours({
    contours: data.contours, labels: LABELS, imageSize: { width: data.width, height: data.height }, createId: createLocalProjectKey,
  });
  if (data.version === 2 && data.contours.some((contour) => !contour.curve)) {
    throw new FolderWorkspaceError({ code: "FOLDER_INVALID_RECORD", message: `Missing editable curve data in ${path}.` });
  }
  if (data.status === "done" && !contours.length) {
    throw new FolderWorkspaceError({ code: "FOLDER_INVALID_RECORD", message: `${path}: Done requires at least one contour.` });
  }
  const ids = new Set();
  for (const contour of data.contours) {
    if (typeof contour.id !== "string" || !contour.id || ids.has(contour.id) ||
        contour.points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || (data.version === 1 && (point.x < 0 || point.y < 0 || point.x > data.width || point.y > data.height)))) {
      throw new FolderWorkspaceError({ code: "FOLDER_INVALID_RECORD", message: `Invalid contour coordinates or IDs in ${path}.` });
    }
    ids.add(contour.id);
  }
  const draft = data.draft || { points: [], label: "face_outline", closed: true };
  const label = LABELS.find((candidate) => candidate.id === draft.label);
  if (!label || typeof draft.closed !== "boolean" ||
      !label.allowedShapeTypes.includes(draft.closed ? "polygon" : "linestrip") ||
      !Array.isArray(draft.points) || draft.points.length > MAX_DRAFT_POINTS ||
      draft.points.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y) || point.x < 0 || point.y < 0 || point.x > data.width || point.y > data.height)) {
    throw new FolderWorkspaceError({ code: "FOLDER_INVALID_RECORD", message: `Invalid unfinished drawing in ${path}.` });
  }
  // Existing importer validation rounds to image pixels. Folder saves preserve
  // the editor's fractional coordinates across reopen instead.
  return { ...data, contours: data.version === 2 ? contours : contours.map((contour, index) => ({ ...contour, points: data.contours[index].points.map((point) => ({ x: point.x, y: point.y })) })), draft };
}

async function acquireWorkspaceLock(id) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await new Promise((resolve, reject) => {
    navigator.locks.request(`face-contour-folder:${id}`, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        reject(new FolderWorkspaceError({ code: "FOLDER_BUSY", message: "This output folder is already open in another tab. Exit that project first." }));
        return;
      }
      resolve();
      await held;
    }).catch(reject);
  });
  return release;
}

async function digestFile(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function openFolderWorkspace({ sourceHandle, outputHandle, onProgress = () => {} }) {
  await ensureFolderPermission({ handle: sourceHandle, mode: "read" });
  await ensureFolderPermission({ handle: outputHandle, mode: "readwrite" });
  if (await sourceHandle.resolve(outputHandle) !== null || await outputHandle.resolve(sourceHandle) !== null) {
    throw new FolderWorkspaceError({ code: "FOLDER_OVERLAP", message: "Choose separate, non-nested image and output folders. Original images stay read-only." });
  }
  const sources = await scanImageDirectory(sourceHandle);
  const paths = sources.map(({ path }) => path);
  if (!globalThis.navigator?.locks) throw new FolderWorkspaceError({ code: "FOLDER_UNSUPPORTED", message: "This browser cannot protect folder writes. Use a current desktop Chrome or Edge." });
  // Until a manifest exists there is no workspace ID to lock. Serialize this
  // short read/create/cleanup phase; normal saves still use a per-workspace lease.
  const manifestRead = await navigator.locks.request(MANIFEST_INITIALIZATION_LOCK, async () => {
    const existing = await readJson({ root: outputHandle, path: FOLDER_MANIFEST });
    if (existing) return existing;
    // An unowned annotations directory must not be adopted and overwritten.
    for await (const [name] of outputHandle.entries()) {
      if (name === "annotations" || name === FOLDER_SESSION) throw new FolderWorkspaceError({ code: "FOLDER_UNOWNED", message: "This output folder already contains annotation files without a workspace manifest. Choose an empty output folder or restore its manifest." });
    }
    const data = { kind: WORKSPACE_KIND, version: 1, id: createLocalProjectKey(), name: sourceHandle.name, paths, createdAt: new Date().toISOString() };
    const text = await writeJson({ root: outputHandle, path: FOLDER_MANIFEST, data, expectedText: null });
    return { data, text };
  });
  const manifest = manifestRead.data;
  if (manifest.kind !== WORKSPACE_KIND || manifest.version !== 1 || typeof manifest.id !== "string" || !manifest.id ||
      !Array.isArray(manifest.paths) || manifest.paths.length !== paths.length || manifest.paths.some((path, index) => path !== paths[index])) {
    throw new FolderWorkspaceError({ code: "FOLDER_MISMATCH", message: "This output folder belongs to a different image list or unsupported workspace. Choose the original image folder or a new output folder." });
  }
  const release = await acquireWorkspaceLock(manifest.id);
  try {
    const sourceByPath = new Map(sources.map((source) => [source.path, source]));
    const images = [];
    for (const source of sources) {
      const stored = await readJson({ root: outputHandle, path: annotationPath(source.path) });
      const record = stored ? validateFolderImage({ data: stored.data, path: source.path }) : null;
      images.push({ id: source.path, name: source.name, path: source.path, width: record?.width || 0, height: record?.height || 0, status: record?.status || "unlabeled" });
      if (images.length % FOLDER_QUEUE_PAGE_SIZE === 0) onProgress(`Reading saved annotations: ${images.length} / ${sources.length}…`);
    }
    const sessionRead = await readJson({ root: outputHandle, path: FOLDER_SESSION });
    const session = sessionRead?.data;
    if (session && (session.version !== 1 || session.workspaceId !== manifest.id || !sourceByPath.has(session.currentPath))) {
      throw new FolderWorkspaceError({ code: "FOLDER_INVALID_RECORD", message: "The workspace session file is invalid. Restore it from backup before reopening." });
    }
    const project = createAnnotationProject({ name: manifest.name, images, taskSchema: buildTaskSchema(LABELS), sourceType: "directory", localProjectKey: `${FOLDER_PROJECT_PREFIX}${manifest.id}` });
    project.currentImageId = session?.currentPath || images[0].id;
    project.preferences = session?.preferences || {};
    let current = null;
    let sessionText = sessionRead?.text ?? null;
    let closed = false;

    return {
      project, sourceHandle, outputHandle,
      close() { closed = true; release(); },
      async loadImage(imageRecord) {
        if (closed) throw new FolderWorkspaceError({ code: "FOLDER_CLOSED", message: "Reopen this folder workspace before continuing." });
        const source = sourceByPath.get(imageRecord.path);
        if (!source) throw new FolderWorkspaceError({ code: "FOLDER_MISSING", message: "This image is not in the selected folder." });
        const file = await source.handle.getFile();
        if (!file.size || file.size > MAX_FOLDER_IMAGE_BYTES) throw new FolderWorkspaceError({ code: "FOLDER_LIMIT", message: `${imageRecord.path} exceeds the 128 MiB per-image limit or is empty.` });
        const sha256 = await digestFile(file);
        const stored = await readJson({ root: outputHandle, path: annotationPath(imageRecord.path) });
        const record = stored ? validateFolderImage({ data: stored.data, path: imageRecord.path }) : null;
        if (record && (record.source.sha256 !== sha256 || record.source.size !== file.size)) {
          throw new FolderWorkspaceError({ code: "FOLDER_SOURCE_CHANGED", message: `The original image changed: ${imageRecord.path}. Its annotations were not applied or overwritten. Restore the original image first.` });
        }
        // Commit the current source binding only after the caller successfully decodes it.
        const binding = { path: source.path, handle: source.handle, expectedText: stored?.text ?? null, source: { size: file.size, lastModified: file.lastModified, sha256 } };
        return { file, record, commit() { current = binding; } };
      },
      buildImageFile(image) {
        if (!current || current.path !== image.path) throw new FolderWorkspaceError({ code: "FOLDER_MISSING", message: "Load the image before saving its annotations." });
        return { kind: FOLDER_IMAGE_KIND, version: 2, relativePath: image.path, source: { ...current.source }, width: image.width, height: image.height, status: image.status,
          contours: serializeContours(image.contours || [], LABELS), selectedId: image.selectedId, draft: image.draft, revision: createLocalProjectKey(), updatedAt: new Date().toISOString() };
      },
      async saveImage({ image, preferences }) {
        if (closed) throw new FolderWorkspaceError({ code: "FOLDER_CLOSED", message: "The folder workspace was closed before saving." });
        const data = this.buildImageFile(image);
        validateFolderImage({ data, path: image.path });
        const file = await current.handle.getFile();
        if (file.size !== current.source.size || file.lastModified !== current.source.lastModified) {
          throw new FolderWorkspaceError({ code: "FOLDER_SOURCE_CHANGED", message: "The current original image changed on disk. Download current JSON before reopening." });
        }
        current.expectedText = await writeJson({ root: outputHandle, path: annotationPath(image.path), data, expectedText: current.expectedText });
        sessionText = await writeJson({ root: outputHandle, path: FOLDER_SESSION,
          data: { version: 1, workspaceId: manifest.id, currentPath: image.path, preferences }, expectedText: sessionText });
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

// Optional recent-project bookmarks. These never contain original pixels or annotation records.
async function bookmarkCommand({ mode = "readonly", action }) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(FOLDER_BOOKMARK_DB, 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore("bookmarks", { keyPath: "localProjectKey" });
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close(); resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new FolderWorkspaceError({ code: "FOLDER_BOOKMARK", message: "Close older tabs to access recent folder projects." })); };
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("bookmarks", mode);
      const request = action(transaction.objectStore("bookmarks"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error || new Error("Folder bookmark operation failed."));
    });
  } finally { database.close(); }
}

export function listFolderBookmarks() {
  return bookmarkCommand({ action: (store) => store.getAll() });
}

export function rememberFolderWorkspace(workspace) {
  const { project, sourceHandle, outputHandle } = workspace;
  return bookmarkCommand({ mode: "readwrite", action: (store) => store.put({
    localProjectKey: project.localProjectKey, name: project.name, source: project.source,
    images: project.images.map(({ id, name, path, status }) => ({ id, name, path, status })),
    updatedAt: new Date().toISOString(), sourceHandle, outputHandle,
  }) });
}

export function forgetFolderBookmark(localProjectKey) {
  return bookmarkCommand({ mode: "readwrite", action: (store) => store.delete(localProjectKey) });
}
