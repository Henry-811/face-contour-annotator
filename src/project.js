export const PROJECT_JSON_VERSION = "face-contour-project-v1";

export const IMAGE_STATUSES = [
  "unlabeled",
  "in_progress",
  "done",
  "skipped",
  "needs_review",
];

export function isImageStatus(status) {
  return IMAGE_STATUSES.includes(status);
}

export function createLocalProjectKey() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const randomPart = Math.random().toString(36).slice(2);
  return `project-${Date.now().toString(36)}-${randomPart}`;
}

export function createImageId({ localProjectKey, index }) {
  if (!localProjectKey || !Number.isInteger(index) || index < 0) {
    throw new Error("An image ID needs a local project key and a non-negative index.");
  }
  return `project-image:${localProjectKey}:${String(index + 1).padStart(4, "0")}`;
}

export function createLocalWriteToken() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const randomPart = Math.random().toString(36).slice(2);
  return `local-${Date.now().toString(36)}-${randomPart}`;
}

export function getFilePath(file) {
  return file?.webkitRelativePath || file?.name || "image";
}

export function cloneProjectContours(contours = []) {
  return contours.map((contour) => ({
    ...contour,
    points: contour.points.map((point) => ({ ...point })),
  }));
}

export function toProjectImageMetadata(image) {
  return {
    id: image.id,
    name: image.name,
    path: image.path || image.name,
    width: image.width,
    height: image.height,
    status: isImageStatus(image.status) ? image.status : "unlabeled",
    selectedId: image.selectedId || null,
    updatedAt: image.updatedAt || new Date().toISOString(),
  };
}

export function toProjectImageRecord(image) {
  return {
    ...toProjectImageMetadata(image),
    contours: cloneProjectContours(image.contours || []),
  };
}

export function toProjectImageAsset(image) {
  return {
    id: image.id,
    dataUrl: image.dataUrl,
    updatedAt: image.updatedAt || new Date().toISOString(),
  };
}

export function toProjectMetadata(project) {
  return {
    ...project,
    images: (project.images || []).map(toProjectImageMetadata),
  };
}

export function hydrateProjectImages(project, imageRecords = []) {
  const recordById = new Map(imageRecords.filter(Boolean).map((image) => [image.id, image]));
  return {
    ...project,
    images: (project.images || []).map((image) => {
      const record = recordById.get(image.id);
      if (!record && !Array.isArray(image.contours)) {
        throw new Error(`Stored annotation record is missing for ${image.path || image.name || image.id}.`);
      }
      return {
        ...image,
        ...(record || {}),
        dataUrl: image.dataUrl || record?.dataUrl,
      };
    }),
  };
}

export function createProjectImage({
  id,
  name,
  path,
  width,
  height,
  dataUrl,
  contours = [],
  status = "unlabeled",
}) {
  return {
    id,
    name,
    path: path || name,
    width,
    height,
    dataUrl,
    status: isImageStatus(status) ? status : "unlabeled",
    contours: cloneProjectContours(contours),
    selectedId: contours[0]?.id || null,
    updatedAt: new Date().toISOString(),
  };
}

export function releaseProjectImageAssets(project) {
  if (!project?.images) {
    return project;
  }
  return {
    ...project,
    images: project.images.map(({ dataUrl: _dataUrl, ...image }) => image),
  };
}

export function createAnnotationProject({
  name = "Face contour project",
  images,
  taskSchema,
  sourceType = "files",
  preferences = {},
  localProjectKey = createLocalProjectKey(),
  localWriteToken = createLocalWriteToken(),
}) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error("A project needs at least one image.");
  }
  return {
    // Browser-only storage/routing key. The annotation-file mapper intentionally
    // does not expose this value.
    localProjectKey,
    name,
    version: PROJECT_JSON_VERSION,
    source: {
      type: sourceType,
      importedAt: new Date().toISOString(),
    },
    // Local compare-and-swap lease. This is never part of the portable annotation file.
    localWriteToken,
    taskSchema,
    images,
    currentImageId: images[0].id,
    preferences,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function getProgress(images = []) {
  return images.reduce(
    (progress, image) => {
      progress.total += 1;
      if (image.status === "done") {
        progress.done += 1;
      } else if (image.status === "skipped") {
        progress.skipped += 1;
      } else if (image.status === "needs_review") {
        progress.needs_review += 1;
      } else if (image.status === "in_progress") {
        progress.in_progress += 1;
      } else {
        progress.unlabeled += 1;
      }
      return progress;
    },
    {
      total: 0,
      done: 0,
      skipped: 0,
      needs_review: 0,
      in_progress: 0,
      unlabeled: 0,
    },
  );
}

export function getCurrentImage(project) {
  if (!project?.images?.length) {
    return null;
  }
  return (
    project.images.find((image) => image.id === project.currentImageId) || project.images[0]
  );
}

export function getImageIndex(project, imageId) {
  if (!project?.images?.length) {
    return -1;
  }
  return project.images.findIndex((image) => image.id === imageId);
}

export function getAdjacentImageId(project, direction) {
  const currentIndex = getImageIndex(project, project?.currentImageId);
  if (currentIndex === -1) {
    return null;
  }
  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= project.images.length) {
    return null;
  }
  return project.images[nextIndex].id;
}

export function touchProject(project) {
  if (project) {
    project.updatedAt = new Date().toISOString();
  }
}
