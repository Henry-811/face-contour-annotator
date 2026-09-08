// Runs inside the disposable Chromium page. All handles/streams are native;
// only the named filesystem failure boundary is substituted for each scenario.
export async function runFolderFirstWriteScenarios() {
  const folder = await import("/src/folder-workspace.js");
  const root = await navigator.storage.getDirectory();
  const sourceHandle = await root.getDirectoryHandle("first-write-images", { create: true });
  const imageBytes = await (await fetch("/samples/face-lena.jpg")).arrayBuffer();
  const nativeWritable = FileSystemFileHandle.prototype.createWritable;
  const nativeRemove = FileSystemDirectoryHandle.prototype.removeEntry;
  const results = [];

  function check(condition, message) {
    if (!condition) throw new Error(message);
  }
  async function entry({ directory, path, create = false }) {
    const parts = path.split("/");
    for (const name of parts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(name, { create });
    }
    return directory.getFileHandle(parts.at(-1), { create });
  }
  async function write({ directory, path, data }) {
    const handle = await entry({ directory, path, create: true });
    const stream = await nativeWritable.call(handle);
    await stream.write(data);
    await stream.close();
  }
  async function contents({ directory, path }) {
    try {
      return await (await (await entry({ directory, path })).getFile()).text();
    } catch (error) {
      if (error.name === "NotFoundError") return null;
      throw error;
    }
  }
  async function rejection(action) {
    try { await action(); }
    catch (error) { return error; }
    throw new Error("Expected a filesystem failure.");
  }
  async function injectFailure({ name, phase, action, cleanupDenied = false, changedContent }) {
    let hit = false;
    FileSystemFileHandle.prototype.createWritable = async function(...args) {
      if (this.name !== name) return nativeWritable.apply(this, args);
      hit = true;
      const failure = () => new DOMException("Injected first-write failure", "QuotaExceededError");
      if (changedContent !== undefined) {
        const external = await nativeWritable.call(this);
        await external.write(changedContent);
        await external.close();
      }
      if (phase === "open") throw failure();
      const stream = await nativeWritable.apply(this, args);
      return {
        async write(data) {
          if (phase === "write") throw failure();
          await stream.write(data);
        },
        async close() { throw failure(); },
        async abort() {
          await stream.abort();
          if (phase === "abort") throw new DOMException("Injected abort failure", "InvalidStateError");
        },
      };
    };
    if (cleanupDenied) {
      FileSystemDirectoryHandle.prototype.removeEntry = async function(target, options) {
        if (target === name) throw new DOMException("Injected cleanup denial", "NotAllowedError");
        return nativeRemove.call(this, target, options);
      };
    }
    try {
      const error = await rejection(action);
      check(hit, `Failure boundary ${name}/${phase} was not reached.`);
      return error;
    } finally {
      FileSystemFileHandle.prototype.createWritable = nativeWritable;
      FileSystemDirectoryHandle.prototype.removeEntry = nativeRemove;
    }
  }
  async function output(name) {
    return root.getDirectoryHandle(`first-write-${name}`, { create: true });
  }
  function open(outputHandle) {
    return folder.openFolderWorkspace({ sourceHandle, outputHandle });
  }
  async function select({ workspace, path }) {
    const image = workspace.project.images.find((item) => item.path === path);
    const loaded = await workspace.loadImage(image);
    loaded.commit();
    Object.assign(image, {
      width: 512, height: 512, status: "unlabeled", contours: [], selectedId: null,
      draft: { label: "face_outline", closed: true, points: [] },
    });
    return image;
  }
  await write({ directory: sourceHandle, path: "a.jpg", data: imageBytes });
  await write({ directory: sourceHandle, path: "sub/b.jpg", data: imageBytes });

  for (const phase of ["open", "write", "close"]) {
    const outputHandle = await output(`manifest-${phase}`);
    const error = await injectFailure({ name: folder.FOLDER_MANIFEST, phase, action: () => open(outputHandle) });
    check(error.name === "QuotaExceededError", `Manifest ${phase}: original failure was lost.`);
    check(await contents({ directory: outputHandle, path: folder.FOLDER_MANIFEST }) === null,
      `Manifest ${phase}: failed first write left a blocking empty file.`);
    const reopened = await open(outputHandle);
    reopened.close();
    results.push(`manifest-${phase}`);
  }
  for (const phase of ["open", "write", "close"]) {
    const outputHandle = await output(`annotation-${phase}`);
    const workspace = await open(outputHandle);
    try {
      const first = await select({ workspace, path: "a.jpg" });
      await workspace.saveImage({ image: first, preferences: {} });
      const previous = await contents({ directory: outputHandle, path: "annotations/a.jpg.json" });
      const second = await select({ workspace, path: "sub/b.jpg" });
      await injectFailure({ name: "b.jpg.json", phase, action: () => workspace.saveImage({ image: second, preferences: {} }) });
      check(await contents({ directory: outputHandle, path: "annotations/sub/b.jpg.json" }) === null,
        `Annotation ${phase}: failed first write left an empty file.`);
      check(await contents({ directory: outputHandle, path: "annotations/a.jpg.json" }) === previous,
        `Annotation ${phase}: prior saved work changed.`);
    } finally { workspace.close(); }
    const reopened = await open(outputHandle);
    try {
      const second = await select({ workspace: reopened, path: "sub/b.jpg" });
      await reopened.saveImage({ image: second, preferences: {} });
    } finally { reopened.close(); }
    results.push(`annotation-${phase}`);
  }
  for (const phase of ["open", "write", "close"]) {
    const outputHandle = await output(`session-${phase}`);
    const workspace = await open(outputHandle);
    try {
      const image = await select({ workspace, path: "a.jpg" });
      await injectFailure({ name: folder.FOLDER_SESSION, phase, action: () => workspace.saveImage({ image, preferences: {} }) });
      check(await contents({ directory: outputHandle, path: folder.FOLDER_SESSION }) === null,
        `Session ${phase}: failed first write left an empty file.`);
      check((await contents({ directory: outputHandle, path: "annotations/a.jpg.json" }))?.length > 0,
        `Session ${phase}: committed image must remain available.`);
    } finally { workspace.close(); }
    const reopened = await open(outputHandle);
    reopened.close();
    results.push(`session-${phase}`);
  }
  for (const phase of ["open", "write", "close"]) {
    const outputHandle = await output(`existing-${phase}`);
    const workspace = await open(outputHandle);
    try {
      const image = await select({ workspace, path: "a.jpg" });
      await workspace.saveImage({ image, preferences: {} });
      const previous = await contents({ directory: outputHandle, path: "annotations/a.jpg.json" });
      image.status = "needs_review";
      await injectFailure({ name: "a.jpg.json", phase, action: () => workspace.saveImage({ image, preferences: {} }) });
      check(await contents({ directory: outputHandle, path: "annotations/a.jpg.json" }) === previous,
        `Existing file ${phase}: saved data changed or was deleted.`);
    } finally { workspace.close(); }
    results.push(`existing-file-${phase}-kept`);
  }

  const preExisting = await output("preexisting-empty");
  await write({ directory: preExisting, path: folder.FOLDER_MANIFEST, data: "" });
  const emptyError = await rejection(() => open(preExisting));
  check(emptyError.code === "FOLDER_INVALID_JSON", "Pre-existing empty files must not become new workspaces.");
  check(await contents({ directory: preExisting, path: folder.FOLDER_MANIFEST }) === "", "Pre-existing empty file was deleted.");
  results.push("preexisting-empty-kept");

  const changed = await output("changed-file");
  await injectFailure({ name: folder.FOLDER_MANIFEST, phase: "open", changedContent: "external data", action: () => open(changed) });
  check(await contents({ directory: changed, path: folder.FOLDER_MANIFEST }) === "external data", "Changed content was deleted by cleanup.");
  results.push("changed-file-kept");

  const denied = await output("cleanup-denied");
  const cleanupError = await injectFailure({ name: folder.FOLDER_MANIFEST, phase: "open", cleanupDenied: true, action: () => open(denied) });
  check(cleanupError.code === "FOLDER_WRITE_RECOVERY" && cleanupError.message.includes(folder.FOLDER_MANIFEST),
    "Cleanup failure must report the exact file needing recovery.");
  check(await contents({ directory: denied, path: folder.FOLDER_MANIFEST }) === "", "Denied cleanup unexpectedly removed the file.");
  results.push("cleanup-denied-visible");

  const abortOutput = await output("abort-unconfirmed");
  const abortError = await injectFailure({ name: folder.FOLDER_MANIFEST, phase: "abort", action: () => open(abortOutput) });
  check(abortError.code === "FOLDER_WRITE_RECOVERY", "An unconfirmed abort must not permit automatic deletion.");
  check(await contents({ directory: abortOutput, path: folder.FOLDER_MANIFEST }) === "", "File was removed after an unconfirmed abort.");
  results.push("unconfirmed-abort-kept");

  // A pending initial creator has no workspace ID yet. A second opener must
  // wait for its cleanup rather than interpreting its temporary empty manifest.
  const competingOutput = await output("competing-initializers");
  let releaseFirst;
  let enteredFirst;
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  FileSystemFileHandle.prototype.createWritable = async function(...args) {
    if (this.name === folder.FOLDER_MANIFEST && !releaseFirst) {
      enteredFirst();
      await new Promise((resolve) => { releaseFirst = resolve; });
      throw new DOMException("First initializer failed", "QuotaExceededError");
    }
    return nativeWritable.apply(this, args);
  };
  try {
    const failedFirst = rejection(() => open(competingOutput));
    await firstEntered;
    const second = open(competingOutput);
    // Observe the actual Web Lock queue rather than relying on a fixed sleep.
    let queued = false;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const locks = await navigator.locks.query();
      if (locks.pending.some((lock) => lock.name === "face-contour-folder:manifest-initialization")) {
        queued = true;
        break;
      }
    }
    releaseFirst();
    check((await failedFirst).name === "QuotaExceededError", "First initializer lost its original error.");
    const workspace = await second;
    workspace.close();
    check(queued, "Concurrent initialization was not serialized through a creation lock.");
    check(JSON.parse(await contents({ directory: competingOutput, path: folder.FOLDER_MANIFEST })).kind,
      "Competing initializer did not produce a valid manifest after cleanup.");
  } finally {
    releaseFirst?.();
    FileSystemFileHandle.prototype.createWritable = nativeWritable;
  }
  results.push("competing-initializers");
  return results;
}
