import {
  CURRENT_PROJECT_KEY,
  DATA_URL_SIZE_RATIO,
  DRAFT_DB_NAME,
  DRAFT_DB_VERSION,
  DRAFT_IMAGE_KEY,
  DRAFT_STORE_NAME,
  PROJECT_IMAGE_ASSET_STORE_NAME,
  PROJECT_IMAGE_STORE_NAME,
  PROJECT_STORE_NAME,
  STORAGE_HEADROOM_RATIO,
} from "./config.js?v=image-set-annotations-1";
import {
  toProjectImageAsset,
  toProjectImageRecord,
  toProjectMetadata,
} from "./project.js?v=image-set-annotations-1";

function openDraftDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is not available."));
      return;
    }
    const request = window.indexedDB.open(DRAFT_DB_NAME, DRAFT_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        database.createObjectStore(DRAFT_STORE_NAME);
      }
      if (!database.objectStoreNames.contains(PROJECT_STORE_NAME)) {
        database.createObjectStore(PROJECT_STORE_NAME);
      }
      if (!database.objectStoreNames.contains(PROJECT_IMAGE_STORE_NAME)) {
        database.createObjectStore(PROJECT_IMAGE_STORE_NAME);
      }
      if (!database.objectStoreNames.contains(PROJECT_IMAGE_ASSET_STORE_NAME)) {
        database.createObjectStore(PROJECT_IMAGE_ASSET_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB could not be opened."));
  });
}

async function withStore(storeName, mode, callback) {
  const database = await openDraftDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let callbackResult;
      let callbackFailure = null;
      let abortRequested = false;
      transaction.oncomplete = () => resolve(callbackResult);
      transaction.onerror = () =>
        reject(callbackFailure || transaction.error || new Error("IndexedDB transaction failed."));
      transaction.onabort = () =>
        reject(callbackFailure || transaction.error || new Error("IndexedDB transaction aborted."));
      const abort = (error) => {
        if (abortRequested) {
          return;
        }
        abortRequested = true;
        callbackFailure = error;
        transaction.abort();
      };
      try {
        callbackResult = callback(store);
        if (typeof callbackResult?.then === "function") {
          Promise.resolve(callbackResult).catch((error) => {
            callbackFailure = callbackFailure || error;
            if (!abortRequested) {
              try {
                abort(error);
              } catch (abortError) {
                reject(
                  new AggregateError(
                    [error, abortError],
                    "IndexedDB callback and transaction abort both failed.",
                  ),
                );
              }
            }
          });
        }
      } catch (error) {
        abort(error);
      }
    });
  } finally {
    database.close();
  }
}

function withDraftStore(mode, callback) {
  return withStore(DRAFT_STORE_NAME, mode, callback);
}

function withProjectStore(mode, callback) {
  return withStore(PROJECT_STORE_NAME, mode, callback);
}

function withProjectImageStore(mode, callback) {
  return withStore(PROJECT_IMAGE_STORE_NAME, mode, callback);
}

function withProjectImageAssetStore(mode, callback) {
  return withStore(PROJECT_IMAGE_ASSET_STORE_NAME, mode, callback);
}

async function withProjectStores(storeNames, callback) {
  const database = await openDraftDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeNames, "readwrite");
      const stores = Object.fromEntries(
        storeNames.map((storeName) => [storeName, transaction.objectStore(storeName)]),
      );
      let callbackResult;
      let callbackFailure = null;
      let abortRequested = false;
      transaction.oncomplete = () => resolve(callbackResult);
      transaction.onerror = () =>
        reject(
          callbackFailure ||
            transaction.error ||
            new Error("IndexedDB image-set transaction failed."),
        );
      transaction.onabort = () =>
        reject(
          callbackFailure ||
            transaction.error ||
            new Error("IndexedDB image-set transaction aborted."),
        );
      const control = {
        abort(error) {
          if (abortRequested) {
            return;
          }
          abortRequested = true;
          callbackFailure = error;
          transaction.abort();
        },
      };
      try {
        callbackResult = callback(stores, control);
        if (typeof callbackResult?.then === "function") {
          Promise.resolve(callbackResult).catch((error) => {
            callbackFailure = callbackFailure || error;
            if (!abortRequested) {
              try {
                control.abort(error);
              } catch (abortError) {
                reject(
                  new AggregateError(
                    [error, abortError],
                    "IndexedDB callback and transaction abort both failed.",
                  ),
                );
              }
            }
          });
        }
      } catch (error) {
        control.abort(error);
      }
    });
  } finally {
    database.close();
  }
}

export class StaleImageSetWriteError extends Error {
  constructor() {
    super("A different image set is now active in another tab. Export this tab's annotations before continuing.");
    this.name = "StaleImageSetWriteError";
    this.code = "STALE_IMAGE_SET_WRITE";
  }
}

function writeIfCurrentImageSet({ stores, control, project, write }) {
  return new Promise((resolve, reject) => {
    const request = stores[PROJECT_STORE_NAME].get(CURRENT_PROJECT_KEY);
    request.onsuccess = () => {
      const currentProject = request.result;
      if (
        !project?.localWriteToken ||
        currentProject?.localWriteToken !== project.localWriteToken
      ) {
        const error = new StaleImageSetWriteError();
        control.abort(error);
        reject(error);
        return;
      }
      try {
        write();
        resolve();
      } catch (error) {
        control.abort(error);
        reject(error);
      }
    };
    request.onerror = () =>
      reject(request.error || new Error("Current image set could not be checked."));
  });
}

function getProjectRevisionSignature(project) {
  return JSON.stringify({
    localWriteToken: project?.localWriteToken || null,
    version: project?.version || null,
    name: project?.name || null,
    createdAt: project?.createdAt || null,
    updatedAt: project?.updatedAt || null,
    currentImageId: project?.currentImageId || null,
    sourceType: project?.source?.type || null,
    sourceImportedAt: project?.source?.importedAt || null,
    images: (project?.images || []).map((image) => ({
      id: image.id,
      path: image.path || image.name,
      width: image.width,
      height: image.height,
      status: image.status,
      updatedAt: image.updatedAt || null,
      embeddedDataBytes: typeof image.dataUrl === "string" ? image.dataUrl.length : null,
      embeddedContourCount: Array.isArray(image.contours) ? image.contours.length : null,
    })),
  });
}

function writeIfExpectedImageSet({ stores, control, expectedProject, write }) {
  return new Promise((resolve, reject) => {
    const request = stores[PROJECT_STORE_NAME].get(CURRENT_PROJECT_KEY);
    request.onsuccess = () => {
      if (
        getProjectRevisionSignature(request.result) !==
        getProjectRevisionSignature(expectedProject)
      ) {
        const error = new StaleImageSetWriteError();
        control.abort(error);
        reject(error);
        return;
      }
      try {
        write();
        resolve();
      } catch (error) {
        control.abort(error);
        reject(error);
      }
    };
    request.onerror = () =>
      reject(request.error || new Error("Current image set could not be checked."));
  });
}

function prepareProjectReplacement(project) {
  if (!project?.localWriteToken) {
    throw new Error("A replacement image set needs a local write token.");
  }
  const metadata = toProjectMetadata(project);
  const records = project.images.map(toProjectImageRecord);
  const assets = project.images.map(toProjectImageAsset);
  if (assets.some((asset) => typeof asset.dataUrl !== "string" || !asset.dataUrl)) {
    throw new Error("Every replacement image needs source data.");
  }
  return { metadata, records, assets };
}

function writeProjectReplacement(stores, replacement) {
  stores[PROJECT_STORE_NAME].clear();
  stores[PROJECT_IMAGE_STORE_NAME].clear();
  stores[PROJECT_IMAGE_ASSET_STORE_NAME].clear();
  stores[PROJECT_STORE_NAME].put(replacement.metadata, CURRENT_PROJECT_KEY);
  replacement.records.forEach((record) =>
    stores[PROJECT_IMAGE_STORE_NAME].put(record, record.id),
  );
  replacement.assets.forEach((asset) =>
    stores[PROJECT_IMAGE_ASSET_STORE_NAME].put(asset, asset.id),
  );
}

export function putStoredImage(dataUrl) {
  return withDraftStore("readwrite", (store) => {
    store.put({ dataUrl, updatedAt: Date.now() }, DRAFT_IMAGE_KEY);
  });
}

export function getStoredImage() {
  return withDraftStore(
    "readonly",
    (store) =>
      new Promise((resolve, reject) => {
        const request = store.get(DRAFT_IMAGE_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () =>
          reject(request.error || new Error("Stored image could not be read."));
      }),
  );
}

export function deleteStoredImage() {
  return withDraftStore("readwrite", (store) => {
    store.delete(DRAFT_IMAGE_KEY);
  });
}

export function putCurrentProject(project) {
  return withProjectStore("readwrite", (store) => {
    store.put(toProjectMetadata(project), CURRENT_PROJECT_KEY);
  });
}

export function claimCurrentProjectWriteToken({ expectedProject, project }) {
  return withProjectStores(
    [PROJECT_STORE_NAME],
    (stores, control) =>
      writeIfExpectedImageSet({
        stores,
        control,
        expectedProject,
        write() {
          stores[PROJECT_STORE_NAME].put(toProjectMetadata(project), CURRENT_PROJECT_KEY);
        },
      }),
  );
}

export function putProjectSnapshot({ project, image }) {
  return withProjectStores(
    [PROJECT_STORE_NAME, PROJECT_IMAGE_STORE_NAME],
    (stores, control) =>
      writeIfCurrentImageSet({
        stores,
        control,
        project,
        write() {
          stores[PROJECT_STORE_NAME].put(toProjectMetadata(project), CURRENT_PROJECT_KEY);
          if (image) {
            const record = toProjectImageRecord(image);
            stores[PROJECT_IMAGE_STORE_NAME].put(record, record.id);
          }
        },
      }),
  );
}

export function getCurrentProject() {
  return withProjectStore(
    "readonly",
    (store) =>
      new Promise((resolve, reject) => {
        const request = store.get(CURRENT_PROJECT_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () =>
          reject(request.error || new Error("Current project could not be read."));
      }),
  );
}

export function deleteCurrentProject() {
  return withProjectStore("readwrite", (store) => {
    store.delete(CURRENT_PROJECT_KEY);
  });
}

export function putProjectImageRecord(image) {
  return withProjectImageStore("readwrite", (store) => {
    const record = toProjectImageRecord(image);
    store.put(record, record.id);
  });
}

export function putProjectImageRecords(images = []) {
  return withProjectImageStore("readwrite", (store) => {
    images.forEach((image) => {
      const record = toProjectImageRecord(image);
      store.put(record, record.id);
    });
  });
}

export function getProjectImageRecord(imageId) {
  return withProjectImageStore(
    "readonly",
    (store) =>
      new Promise((resolve, reject) => {
        const request = store.get(imageId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () =>
          reject(request.error || new Error("Project image record could not be read."));
      }),
  );
}

export function getProjectImageRecords(imageIds = []) {
  return withProjectImageStore(
    "readonly",
    (store) =>
      new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => {
          const recordById = new Map(
            (request.result || []).map((record) => [record.id, record]),
          );
          resolve(imageIds.map((imageId) => recordById.get(imageId) || null));
        };
        request.onerror = () =>
          reject(request.error || new Error("Project image records could not be read."));
      }),
  );
}

export function putProjectImageAsset(image) {
  return withProjectImageAssetStore("readwrite", (store) => {
    const asset = toProjectImageAsset(image);
    if (asset.dataUrl) {
      store.put(asset, asset.id);
    }
  });
}

export function putProjectImageAssets(images = []) {
  return withProjectImageAssetStore("readwrite", (store) => {
    images.forEach((image) => {
      const asset = toProjectImageAsset(image);
      if (asset.dataUrl) {
        store.put(asset, asset.id);
      }
    });
  });
}

export function getProjectImageAsset(imageId) {
  return withProjectImageAssetStore(
    "readonly",
    (store) =>
      new Promise((resolve, reject) => {
        const request = store.get(imageId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () =>
          reject(request.error || new Error("Project image asset could not be read."));
      }),
  );
}

export function clearProjectImageRecords() {
  return withProjectImageStore("readwrite", (store) => {
    store.clear();
  });
}

export function clearProjectImageAssets() {
  return withProjectImageAssetStore("readwrite", (store) => {
    store.clear();
  });
}

export async function clearCurrentProjectData() {
  await withProjectStores(
    [PROJECT_STORE_NAME, PROJECT_IMAGE_STORE_NAME, PROJECT_IMAGE_ASSET_STORE_NAME],
    (stores) => {
      stores[PROJECT_STORE_NAME].clear();
      stores[PROJECT_IMAGE_STORE_NAME].clear();
      stores[PROJECT_IMAGE_ASSET_STORE_NAME].clear();
    },
  );
}

export function getProjectImageAssets(imageIds = []) {
  return withProjectImageAssetStore(
    "readonly",
    (store) =>
      new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => {
          const assetById = new Map(
            (request.result || []).map((asset) => [asset.id, asset]),
          );
          resolve(imageIds.map((imageId) => assetById.get(imageId) || null));
        };
        request.onerror = () =>
          reject(request.error || new Error("Project image assets could not be read."));
      }),
  );
}

export function replaceCurrentProjectData(project) {
  let replacement;
  try {
    replacement = prepareProjectReplacement(project);
  } catch (error) {
    return Promise.reject(error);
  }
  return withProjectStores(
    [PROJECT_STORE_NAME, PROJECT_IMAGE_STORE_NAME, PROJECT_IMAGE_ASSET_STORE_NAME],
    (stores) => {
      writeProjectReplacement(stores, replacement);
    },
  );
}

export function replaceCurrentProjectDataIfUnchanged({ expectedProject, project }) {
  let replacement;
  try {
    replacement = prepareProjectReplacement(project);
  } catch (error) {
    return Promise.reject(error);
  }
  return withProjectStores(
    [PROJECT_STORE_NAME, PROJECT_IMAGE_STORE_NAME, PROJECT_IMAGE_ASSET_STORE_NAME],
    (stores, control) =>
      writeIfExpectedImageSet({
        stores,
        control,
        expectedProject,
        write() {
          writeProjectReplacement(stores, replacement);
        },
      }),
  );
}

/**
 * Atomically replace annotation metadata/records while preserving the already stored
 * source-image assets. Used when an annotation JSON is applied to the open image set.
 */
export function replaceCurrentProjectAnnotations(project) {
  const metadata = toProjectMetadata(project);
  const records = project.images.map(toProjectImageRecord);
  return withProjectStores(
    [PROJECT_STORE_NAME, PROJECT_IMAGE_STORE_NAME],
    (stores, control) =>
      writeIfCurrentImageSet({
        stores,
        control,
        project,
        write() {
          stores[PROJECT_STORE_NAME].put(metadata, CURRENT_PROJECT_KEY);
          stores[PROJECT_IMAGE_STORE_NAME].clear();
          records.forEach((record) => stores[PROJECT_IMAGE_STORE_NAME].put(record, record.id));
        },
      }),
  );
}

/**
 * Ask the browser to keep this origin's IndexedDB data out of eviction.
 * Without it the annotation store is best-effort and can be dropped without warning.
 */
export async function requestPersistentStorage() {
  if (!navigator.storage?.persist || !navigator.storage?.persisted) {
    return { supported: false, persisted: false };
  }
  if (await navigator.storage.persisted()) {
    return { supported: true, persisted: true };
  }
  return { supported: true, persisted: await navigator.storage.persist() };
}

/** Returns null when the browser cannot estimate, so callers can skip the precheck. */
export async function estimateStorage() {
  if (!navigator.storage?.estimate) {
    return null;
  }
  const estimate = await navigator.storage.estimate();
  return {
    usage: Number(estimate.usage) || 0,
    quota: Number(estimate.quota) || 0,
  };
}

/**
 * Decides whether a batch of image files fits in the remaining storage budget.
 * `fittableCount` lets the caller suggest a workable batch size instead of just failing.
 */
export function planImportStorage({ fileSizes = [], usage = 0, quota = 0 }) {
  const toStoredBytes = (size) => (Number(size) || 0) * DATA_URL_SIZE_RATIO;
  const requiredBytes = fileSizes.reduce((total, size) => total + toStoredBytes(size), 0);
  if (!quota) {
    // No estimate available: let the import through and rely on the save-failure path.
    return {
      known: false,
      fits: true,
      requiredBytes,
      availableBytes: 0,
      fittableCount: fileSizes.length,
    };
  }
  const availableBytes = Math.max(0, quota * STORAGE_HEADROOM_RATIO - usage);
  let consumedBytes = 0;
  let fittableCount = 0;
  for (const size of fileSizes) {
    consumedBytes += toStoredBytes(size);
    if (consumedBytes > availableBytes) {
      break;
    }
    fittableCount += 1;
  }
  return {
    known: true,
    fits: requiredBytes <= availableBytes,
    requiredBytes,
    availableBytes,
    fittableCount,
  };
}

export function removeStoredDraft(storageKey) {
  window.localStorage.removeItem(storageKey);
}

export function readStoredDraft(storageKey) {
  return window.localStorage.getItem(storageKey);
}

export function writeStoredDraft(storageKey, draft) {
  window.localStorage.setItem(storageKey, JSON.stringify(draft));
}
