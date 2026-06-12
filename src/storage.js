import {
  DRAFT_DB_NAME,
  DRAFT_DB_VERSION,
  DRAFT_IMAGE_KEY,
  DRAFT_STORE_NAME,
} from "./config.js";

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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB could not be opened."));
  });
}

async function withDraftStore(mode, callback) {
  const database = await openDraftDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(DRAFT_STORE_NAME, mode);
      const store = transaction.objectStore(DRAFT_STORE_NAME);
      let callbackResult;
      transaction.oncomplete = () => resolve(callbackResult);
      transaction.onerror = () =>
        reject(transaction.error || new Error("Draft asset transaction failed."));
      transaction.onabort = () =>
        reject(transaction.error || new Error("Draft asset transaction aborted."));
      callbackResult = callback(store);
    });
  } finally {
    database.close();
  }
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

export function removeStoredDraft(storageKey) {
  window.localStorage.removeItem(storageKey);
}

export function readStoredDraft(storageKey) {
  return window.localStorage.getItem(storageKey);
}

export function writeStoredDraft(storageKey, draft) {
  window.localStorage.setItem(storageKey, JSON.stringify(draft));
}
