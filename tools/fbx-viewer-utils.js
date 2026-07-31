export const DEFAULT_CAMERA_ANGLE_LIMIT_DEGREES = 20;

export function getFileNameFromPath(path) {
  return String(path || "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || "";
}

export function extractNumericAssetId(path) {
  const fileName = getFileNameFromPath(path);
  const match = fileName.match(/^(\d+)_/);
  return match ? match[1] : null;
}

export function buildBasecolorUrlForFbxName(fbxName, textureRoot) {
  const assetId = extractNumericAssetId(fbxName);
  if (!assetId) {
    return "";
  }
  const normalizedRoot = String(textureRoot || "").replace(/[\\/]+$/, "");
  return `${normalizedRoot}/${assetId}/Basecolor.png`;
}

export function finiteNumber(value, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

export function degreesToRadians(degrees) {
  return (finiteNumber(degrees) * Math.PI) / 180;
}

export function clampAnglePairToBudget(firstDegrees, secondDegrees, limitDegrees) {
  const first = finiteNumber(firstDegrees);
  const second = finiteNumber(secondDegrees);
  const limit = Math.abs(finiteNumber(limitDegrees, DEFAULT_CAMERA_ANGLE_LIMIT_DEGREES));
  const combined = first + second;
  if (!limit || Math.abs(combined) <= limit) {
    return { first, second };
  }
  const scale = limit / Math.abs(combined);
  return {
    first: first * scale,
    second: second * scale,
  };
}

export function normalizeViewerPose(pose, limitDegrees = DEFAULT_CAMERA_ANGLE_LIMIT_DEGREES) {
  const yaw = clampAnglePairToBudget(pose.modelYaw, pose.cameraYaw, limitDegrees);
  const pitch = clampAnglePairToBudget(pose.modelPitch, pose.cameraPitch, limitDegrees);
  return {
    modelYaw: yaw.first,
    cameraYaw: yaw.second,
    modelPitch: pitch.first,
    cameraPitch: pitch.second,
    modelRoll: finiteNumber(pose.modelRoll),
    cameraRoll: finiteNumber(pose.cameraRoll),
  };
}
