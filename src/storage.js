import {
  DATA_URL_SIZE_RATIO,
  DRAFT_DB_NAME,
  DRAFT_DB_VERSION,
  DRAFT_IMAGE_KEY,
  DRAFT_STORE_NAME,
  LEGACY_CURRENT_PROJECT_KEY,
  PROJECT_IMAGE_ASSET_STORE_NAME,
  PROJECT_IMAGE_STORE_NAME,
  PROJECT_STORE_NAME,
  STORAGE_HEADROOM_RATIO,
} from "./config.js?v=workspace-ux-2";
import {
  createLocalProjectKey,
  createLocalWriteToken,
  toProjectImageAsset,
  toProjectImageRecord,
  toProjectMetadata,
} from "./project.js?v=workspace-ux-2";

function openDraftDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is not available."));
      return;
    }
    const request = window.indexedDB.open(DRAFT_DB_NAME, DRAFT_DB_VERSION);
    let settled = false;
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
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(request.error || new Error("IndexedDB could not be opened."));
    };
    request.onblocked = () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(
        new Error(
          "Local project storage is being used by an older tab. Close other Face Contour Lab tabs and refresh.",
        ),
      );
    };
  });
}

async function withStores(storeNames, mode, callback) {
  const database = await openDraftDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeNames, mode);
      const stores = Object.fromEntries(
        storeNames.map((storeName) => [storeName, transaction.objectStore(storeName)]),
      );
      let callbackResult;
      let callbackFailure = null;
      let abortRequested = false;
      transaction.oncomplete = () => resolve(callbackResult);
      transaction.onerror = () =>
        reject(callbackFailure || transaction.error || new Error("IndexedDB transaction failed."));
      transaction.onabort = () =>
        reject(callbackFailure || transaction.error || new Error("IndexedDB transaction aborted."));
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

function withStore(storeName, mode, callback) {
  return withStores([storeName], mode, (stores, control) =>
    callback(stores[storeName], control),
  );
}

function requestValue(request, errorMessage) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(errorMessage));
  });
}

function normalizeProjectKey(localProjectKey) {
  const key = String(localProjectKey || "").trim();
  if (!key || key === LEGACY_CURRENT_PROJECT_KEY) {
    throw new Error("A valid local project key is required.");
  }
  return key;
}

function getProjectImageIds(project) {
  const imageIds = (project?.images || []).map((image) => String(image?.id || "").trim());
  if (!imageIds.length || imageIds.some((imageId) => !imageId)) {
    throw new Error("A local project needs image IDs.");
  }
  if (new Set(imageIds).size !== imageIds.length) {
    throw new Error("Image IDs must be unique inside a local project.");
  }
  return imageIds;
}

function assertProjectOwnsImage(project, imageId) {
  if (!(project?.images || []).some((image) => image.id === imageId)) {
    throw new Error("The image does not belong to this local project.");
  }
}

function prepareLocalProject(project) {
  const localProjectKey = normalizeProjectKey(project?.localProjectKey);
  if (!project?.localWriteToken) {
    throw new Error("A local project needs a write token.");
  }
  const imageIds = getProjectImageIds(project);
  const metadata = toProjectMetadata({ ...project, localProjectKey });
  const records = project.images.map(toProjectImageRecord);
  const assets = project.images.map(toProjectImageAsset);
  if (assets.some((asset) => typeof asset.dataUrl !== "string" || !asset.dataUrl)) {
    throw new Error("Every local project image needs source data.");
  }
  return { localProjectKey, imageIds, metadata, records, assets };
}

export class LocalProjectDeletedError extends Error {
  constructor() {
    super("This local project was deleted in another tab. Export this tab's annotations now.");
    this.name = "LocalProjectDeletedError";
    this.code = "LOCAL_PROJECT_DELETED";
  }
}

export class StaleLocalProjectWriteError extends Error {
  constructor() {
    super("This local project changed in another tab. Export this tab's annotations before continuing.");
    this.name = "StaleLocalProjectWriteError";
    this.code = "STALE_LOCAL_PROJECT_WRITE";
  }
}

function writeIfProjectIsCurrent({ stores, control, project, write }) {
  return new Promise((resolve, reject) => {
    let localProjectKey;
    try {
      localProjectKey = normalizeProjectKey(project?.localProjectKey);
    } catch (error) {
      control.abort(error);
      reject(error);
      return;
    }
    const request = stores[PROJECT_STORE_NAME].get(localProjectKey);
    request.onsuccess = () => {
      const storedProject = request.result;
      if (!storedProject) {
        const error = new LocalProjectDeletedError();
        control.abort(error);
        reject(error);
        return;
      }
      if (
        !project?.localWriteToken ||
        storedProject.localWriteToken !== project.localWriteToken
      ) {
        const error = new StaleLocalProjectWriteError();
        control.abort(error);
        reject(error);
        return;
      }
      try {
        write({ localProjectKey, storedProject });
        resolve();
      } catch (error) {
        control.abort(error);
        reject(error);
      }
    };
    request.onerror = () => {
      const error = request.error || new Error("The local project could not be checked.");
      control.abort(error);
      reject(error);
    };
  });
}

export function putStoredImage(dataUrl) {
  return withStore(DRAFT_STORE_NAME, "readwrite", (store) => {
    store.put({ dataUrl, updatedAt: Date.now() }, DRAFT_IMAGE_KEY);
  });
}

export function getStoredImage() {
  return withStore(DRAFT_STORE_NAME, "readonly", (store) =>
    requestValue(store.get(DRAFT_IMAGE_KEY), "Stored image could not be read.").then(
      (value) => value || null,
    ),
  );
}

export function deleteStoredImage() {
  return withStore(DRAFT_STORE_NAME, "readwrite", (store) => {
    store.delete(DRAFT_IMAGE_KEY);
  });
}

export function listLocalProjects() {
  return withStore(PROJECT_STORE_NAME, "readonly", (store) =>
    requestValue(store.getAll(), "Local projects could not be listed.").then((projects) =>
      (projects || [])
        .filter(
          (project) =>
            project?.localProjectKey && project.localProjectKey !== LEGACY_CURRENT_PROJECT_KEY,
        )
        .sort((left, right) => {
          const updatedDifference =
            Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || "");
          if (Number.isFinite(updatedDifference) && updatedDifference !== 0) {
            return updatedDifference;
          }
          return String(left.name || "").localeCompare(String(right.name || ""));
        }),
    ),
  );
}

export function getLocalProject(localProjectKey) {
  let key;
  try {
    key = normalizeProjectKey(localProjectKey);
  } catch (error) {
    return Promise.reject(error);
  }
  return withStore(PROJECT_STORE_NAME, "readonly", (store) =>
    requestValue(store.get(key), "Local project metadata could not be read.").then(
      (project) => project || null,
    ),
  );
}

export function getLocalProjectImageRecords(localProjectKey, imageIds = []) {
  let key;
  try {
    key = normalizeProjectKey(localProjectKey);
  } catch (error) {
    return Promise.reject(error);
  }
  return withStores(
    [PROJECT_STORE_NAME, PROJECT_IMAGE_STORE_NAME],
    "readonly",
    async (stores) => {
      const project = await requestValue(
        stores[PROJECT_STORE_NAME].get(key),
        "Local project metadata could not be read.",
      );
      if (!project) {
        throw new LocalProjectDeletedError();
      }
      imageIds.forEach((imageId) => assertProjectOwnsImage(project, imageId));
      const requests = imageIds.map((imageId) => stores[PROJECT_IMAGE_STORE_NAME].get(imageId));
      return Promise.all(
        requests.map((request) =>
          requestValue(request, "Local project image records could not be read."),
        ),
      ).then((records) => records.map((record) => record || null));
    },
  );
}

export function getLocalProjectImageRecord(localProjectKey, imageId) {
  return getLocalProjectImageRecords(localProjectKey, [imageId]).then(
    ([record]) => record || null,
  );
}

export function getLocalProjectImageAsset(localProjectKey, imageId) {
  let key;
  try {
    key = normalizeProjectKey(localProjectKey);
  } catch (error) {
    return Promise.reject(error);
  }
  return withStores(
    [PROJECT_STORE_NAME, PROJECT_IMAGE_ASSET_STORE_NAME],
    "readonly",
    async (stores) => {
      const project = await requestValue(
        stores[PROJECT_STORE_NAME].get(key),
        "Local project metadata could not be read.",
      );
      if (!project) {
        throw new LocalProjectDeletedError();
      }
      assertProjectOwnsImage(project, imageId);
      const asset = await requestValue(
        stores[PROJECT_IMAGE_ASSET_STORE_NAME].get(imageId),
        "Local project image asset could not be read.",
      );
      return asset || null;
    },
  );
}

export function createLocalProjectData(project) {
  let prepared;
  try {
    prepared = prepareLocalProject(project);
  } catch (error) {
    return Promise.reject(error);
  }
  return withStores(
    [PROJECT_STORE_NAME, PROJECT_IMAGE_STORE_NAME, PROJECT_IMAGE_ASSET_STORE_NAME],
    "readwrite",
    (stores) => {
      stores[PROJECT_STORE_NAME].add(prepared.metadata, prepared.localProjectKey);
      prepared.records.forEach((record) =>
        stores[PROJECT_IMAGE_STORE_NAME].add(record, record.id),
      );
      prepared.assets.forEach((asset) =>
        stores[PROJECT_IMAGE_ASSET_STORE_NAME].add(asset, asset.id),
      );
    },
  );
}

export function putLocalProjectSnapshot({ project, image }) {
  return withStores(
    [PROJECT_STORE_NAME, PROJECT_IMAGE_STORE_NAME],
    "readwrite",
    (stores, control) =>
      writeIfProjectIsCurrent({
        stores,
        control,
        project,
        write({ localProjectKey, storedProject }) {
          if (image) {
            assertProjectOwnsImage(storedProject, image.id);
          }
          stores[PROJECT_STORE_NAME].put(toProjectMetadata(project), localProjectKey);
          if (image) {
            const record = toProjectImageRecord(image);
            stores[PROJECT_IMAGE_STORE_NAME].put(record, record.id);
          }
        },
      }),
  );
}

export function replaceLocalProjectAnnotations(project) {
  let imageIds;
  try {
    imageIds = getProjectImageIds(project);
  } catch (error) {
    return Promise.reject(error);
  }
  const metadata = toProjectMetadata(project);
  const records = project.images.map(toProjectImageRecord);
  return withStores(
    [PROJECT_STORE_NAME, PROJECT_IMAGE_STORE_NAME],
    "readwrite",
    (stores, control) =>
      writeIfProjectIsCurrent({
        stores,
        control,
        project,
        write({ localProjectKey, storedProject }) {
          const storedImageIds = getProjectImageIds(storedProject);
          if (
            storedImageIds.length !== imageIds.length ||
            storedImageIds.some((imageId, index) => imageId !== imageIds[index])
          ) {
            throw new StaleLocalProjectWriteError();
          }
          storedImageIds.forEach((imageId) =>
            stores[PROJECT_IMAGE_STORE_NAME].delete(imageId),
          );
          records.forEach((record) =>
            stores[PROJECT_IMAGE_STORE_NAME].put(record, record.id),
          );
          stores[PROJECT_STORE_NAME].put(metadata, localProjectKey);
        },
      }),
  );
}

export function putLocalProjectImageAsset({ project, image }) {
  return withStores(
    [PROJECT_STORE_NAME, PROJECT_IMAGE_ASSET_STORE_NAME],
    "readwrite",
    (stores, control) =>
      writeIfProjectIsCurrent({
        stores,
        control,
        project,
        write({ storedProject }) {
          assertProjectOwnsImage(storedProject, image?.id);
          const asset = toProjectImageAsset(image);
          if (!asset.dataUrl) {
            throw new Error("A local project image asset needs source data.");
          }
          stores[PROJECT_IMAGE_ASSET_STORE_NAME].put(asset, asset.id);
        },
      }),
  );
}

export function deleteLocalProject(localProjectKey) {
  let key;
  try {
    key = normalizeProjectKey(localProjectKey);
  } catch (error) {
    return Promise.reject(error);
  }
  return withStores(
    [PROJECT_STORE_NAME, PROJECT_IMAGE_STORE_NAME, PROJECT_IMAGE_ASSET_STORE_NAME],
    "readwrite",
    (stores, control) =>
      new Promise((resolve, reject) => {
        const request = stores[PROJECT_STORE_NAME].get(key);
        request.onsuccess = () => {
          const project = request.result;
          if (!project) {
            resolve(false);
            return;
          }
          try {
            getProjectImageIds(project).forEach((imageId) => {
              stores[PROJECT_IMAGE_STORE_NAME].delete(imageId);
              stores[PROJECT_IMAGE_ASSET_STORE_NAME].delete(imageId);
            });
            stores[PROJECT_STORE_NAME].delete(key);
            resolve(true);
          } catch (error) {
            control.abort(error);
            reject(error);
          }
        };
        request.onerror = () => {
          const error = request.error || new Error("The local project could not be deleted.");
          control.abort(error);
          reject(error);
        };
      }),
  );
}

export function migrateLegacyCurrentProject() {
  return withStores(
    [PROJECT_STORE_NAME, PROJECT_IMAGE_STORE_NAME, PROJECT_IMAGE_ASSET_STORE_NAME],
    "readwrite",
    (stores, control) =>
      new Promise((resolve, reject) => {
        const legacyRequest = stores[PROJECT_STORE_NAME].get(LEGACY_CURRENT_PROJECT_KEY);
        legacyRequest.onsuccess = () => {
          const legacyProject = legacyRequest.result;
          if (!legacyProject) {
            resolve({ migrated: false, localProjectKey: null, imageCount: 0 });
            return;
          }
          let imageIds;
          try {
            imageIds = getProjectImageIds(legacyProject);
          } catch (error) {
            control.abort(error);
            reject(error);
            return;
          }
          const recordResults = new Array(imageIds.length);
          const assetResults = new Array(imageIds.length);
          let pending = imageIds.length * 2;
          const fail = (error) => {
            control.abort(error);
            reject(error);
          };
          const finishRead = () => {
            pending -= 1;
            if (pending !== 0) {
              return;
            }
            try {
              const localProjectKey = createLocalProjectKey();
              const migratedProject = {
                ...legacyProject,
                localProjectKey,
                localWriteToken: legacyProject.localWriteToken || createLocalWriteToken(),
              };
              legacyProject.images.forEach((image, index) => {
                const record = recordResults[index];
                if (!record) {
                  if (!Array.isArray(image.contours)) {
                    throw new Error(
                      `Stored annotation record is missing for ${image.path || image.name || image.id}.`,
                    );
                  }
                  stores[PROJECT_IMAGE_STORE_NAME].put(toProjectImageRecord(image), image.id);
                }
                const asset = assetResults[index];
                if (!asset) {
                  if (typeof image.dataUrl !== "string" || !image.dataUrl) {
                    throw new Error(
                      `Stored source image is missing for ${image.path || image.name || image.id}.`,
                    );
                  }
                  stores[PROJECT_IMAGE_ASSET_STORE_NAME].put(toProjectImageAsset(image), image.id);
                }
              });
              stores[PROJECT_STORE_NAME].add(
                toProjectMetadata(migratedProject),
                localProjectKey,
              );
              stores[PROJECT_STORE_NAME].delete(LEGACY_CURRENT_PROJECT_KEY);
              resolve({ migrated: true, localProjectKey, imageCount: imageIds.length });
            } catch (error) {
              fail(error);
            }
          };
          imageIds.forEach((imageId, index) => {
            const recordRequest = stores[PROJECT_IMAGE_STORE_NAME].get(imageId);
            recordRequest.onsuccess = () => {
              recordResults[index] = recordRequest.result || null;
              finishRead();
            };
            recordRequest.onerror = () =>
              fail(recordRequest.error || new Error("Legacy annotation data could not be read."));
            const assetRequest = stores[PROJECT_IMAGE_ASSET_STORE_NAME].get(imageId);
            assetRequest.onsuccess = () => {
              assetResults[index] = assetRequest.result || null;
              finishRead();
            };
            assetRequest.onerror = () =>
              fail(assetRequest.error || new Error("Legacy image data could not be read."));
          });
        };
        legacyRequest.onerror = () => {
          const error = legacyRequest.error || new Error("Legacy project metadata could not be read.");
          control.abort(error);
          reject(error);
        };
      }),
  );
}

/** Ask the browser to keep this origin's IndexedDB data out of eviction. */
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

export function planImportStorage({ fileSizes = [], usage = 0, quota = 0 }) {
  const toStoredBytes = (size) => (Number(size) || 0) * DATA_URL_SIZE_RATIO;
  const requiredBytes = fileSizes.reduce((total, size) => total + toStoredBytes(size), 0);
  if (!quota) {
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
