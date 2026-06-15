import {
  CURRENT_PROJECT_KEY,
  DRAFT_DB_NAME,
  DRAFT_DB_VERSION,
  DRAFT_IMAGE_KEY,
  DRAFT_STORE_NAME,
  PROJECT_IMAGE_ASSET_STORE_NAME,
  PROJECT_IMAGE_STORE_NAME,
  PROJECT_STORE_NAME,
} from "./config.js";
import {
  toProjectImageAsset,
  toProjectImageRecord,
  toProjectMetadata,
} from "./project.js";

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
      transaction.oncomplete = () => resolve(callbackResult);
      transaction.onerror = () =>
        reject(transaction.error || new Error("IndexedDB transaction failed."));
      transaction.onabort = () =>
        reject(transaction.error || new Error("IndexedDB transaction aborted."));
      callbackResult = callback(store);
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
      Promise.all(
        imageIds.map(
          (imageId) =>
            new Promise((resolve, reject) => {
              const request = store.get(imageId);
              request.onsuccess = () => resolve(request.result || null);
              request.onerror = () =>
                reject(request.error || new Error("Project image records could not be read."));
            }),
        ),
      ),
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
  await deleteCurrentProject();
  await clearProjectImageRecords();
  await clearProjectImageAssets();
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
