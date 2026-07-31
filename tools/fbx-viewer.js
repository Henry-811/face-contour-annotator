import * as THREE from "three";
import { decompressSync } from "fflate";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import {
  buildBasecolorUrlForFbxName,
  degreesToRadians,
  finiteNumber,
  getFileNameFromPath,
  normalizeViewerPose,
} from "./fbx-viewer-utils.js";

const DEFAULT_NUMERIC_FBX_URL = "../run/run/fbx/0_00000.fbx";
const DEFAULT_NAMED_FBX_URL = "../run/run/fbx/S_Child_NChar_NanChild_00000.fbx";
const DEFAULT_TEXTURE_ROOT = "../run/run/motherasset/ori";
const VIEW_DISTANCE = 8;
const GEOMETRY_OVERLAY_NAME = "__fbx_viewer_geometry_overlay";
const MAX_WIRE_SEGMENTS = 180000;

const elements = {
  canvas: document.getElementById("viewerCanvas"),
  statusText: document.getElementById("statusText"),
  fbxUrlInput: document.getElementById("fbxUrlInput"),
  textureUrlInput: document.getElementById("textureUrlInput"),
  loadNumericSampleButton: document.getElementById("loadNumericSampleButton"),
  loadNamedSampleButton: document.getElementById("loadNamedSampleButton"),
  loadUrlButton: document.getElementById("loadUrlButton"),
  autoTextureButton: document.getElementById("autoTextureButton"),
  fbxFileInput: document.getElementById("fbxFileInput"),
  textureFileInput: document.getElementById("textureFileInput"),
  materialModeSelect: document.getElementById("materialModeSelect"),
  wireframeToggle: document.getElementById("wireframeToggle"),
  helpersToggle: document.getElementById("helpersToggle"),
  fitButton: document.getElementById("fitButton"),
  exportPngButton: document.getElementById("exportPngButton"),
  zeroPoseButton: document.getElementById("zeroPoseButton"),
  samplePoseButton: document.getElementById("samplePoseButton"),
  fbxMeta: document.getElementById("fbxMeta"),
  textureMeta: document.getElementById("textureMeta"),
  meshMeta: document.getElementById("meshMeta"),
  vertexMeta: document.getElementById("vertexMeta"),
  boundsMeta: document.getElementById("boundsMeta"),
  poseJsonOutput: document.getElementById("poseJsonOutput"),
  poseInputs: {
    modelYaw: document.getElementById("modelYawInput"),
    modelPitch: document.getElementById("modelPitchInput"),
    modelRoll: document.getElementById("modelRollInput"),
    cameraYaw: document.getElementById("cameraYawInput"),
    cameraPitch: document.getElementById("cameraPitchInput"),
    cameraRoll: document.getElementById("cameraRollInput"),
  },
  poseOutputs: {
    modelYaw: document.getElementById("modelYawOutput"),
    modelPitch: document.getElementById("modelPitchOutput"),
    modelRoll: document.getElementById("modelRollOutput"),
    cameraYaw: document.getElementById("cameraYawOutput"),
    cameraPitch: document.getElementById("cameraPitchOutput"),
    cameraRoll: document.getElementById("cameraRollOutput"),
  },
};

const renderer = new THREE.WebGLRenderer({
  canvas: elements.canvas,
  antialias: true,
  preserveDrawingBuffer: true,
});
renderer.setClearColor(0x303633, 1);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.01, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

const modelRoot = new THREE.Group();
scene.add(modelRoot);

const helperRoot = new THREE.Group();
const axesHelper = new THREE.AxesHelper(2);
const boxHelper = new THREE.Box3Helper(new THREE.Box3(), 0xf2c94c);
helperRoot.add(axesHelper, boxHelper);
scene.add(helperRoot);

scene.add(new THREE.HemisphereLight(0xffffff, 0x3d4540, 2.4));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
keyLight.position.set(3, 4, 5);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xffffff, 0.9);
fillLight.position.set(-4, 2, 3);
scene.add(fillLight);

const state = {
  currentObject: null,
  currentFbxName: "",
  currentFbxSource: "",
  currentTextureName: "",
  currentTexture: null,
  originalMaterials: new Map(),
  baseBox: new THREE.Box3(),
  orthoSize: 4,
  viewPreset: "frontZ",
  pose: {
    modelYaw: 0,
    modelPitch: 0,
    modelRoll: 0,
    cameraYaw: 0,
    cameraPitch: 0,
    cameraRoll: 0,
  },
};

window.fbxViewerDebug = {
  camera,
  modelRoot,
  renderer,
  scene,
  state,
};

function setStatus(message, isError = false) {
  elements.statusText.textContent = message;
  elements.statusText.classList.toggle("is-error", isError);
}

function setLoading(loading) {
  elements.loadUrlButton.disabled = loading;
  elements.loadNumericSampleButton.disabled = loading;
  elements.loadNamedSampleButton.disabled = loading;
}

function loadTexture(textureUrl) {
  const loader = new THREE.TextureLoader();
  loader.crossOrigin = "anonymous";
  return new Promise((resolve, reject) => {
    loader.load(
      textureUrl,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        texture.needsUpdate = true;
        resolve(texture);
      },
      undefined,
      (error) => reject(error),
    );
  });
}

function rememberOriginalMaterials(object) {
  state.originalMaterials.clear();
  object.traverse((child) => {
    if (!child.isMesh) {
      return;
    }
    state.originalMaterials.set(child.uuid, child.material);
  });
}

function createClayMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0xc9a58f,
    side: THREE.DoubleSide,
    wireframe: elements.wireframeToggle.checked,
  });
}

function createBasecolorMaterial(texture) {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: texture,
    side: THREE.DoubleSide,
    wireframe: elements.wireframeToggle.checked,
  });
}

function cloneSourceMaterial(material) {
  if (Array.isArray(material)) {
    return material.map((item) => {
      const clone = item?.clone ? item.clone() : createClayMaterial();
      clone.side = THREE.DoubleSide;
      clone.wireframe = elements.wireframeToggle.checked;
      return clone;
    });
  }
  if (material?.clone) {
    const clone = material.clone();
    clone.side = THREE.DoubleSide;
    clone.wireframe = elements.wireframeToggle.checked;
    return clone;
  }
  return createClayMaterial();
}

function applyMaterials() {
  if (!state.currentObject) {
    return;
  }
  const materialMode = elements.materialModeSelect.value;
  state.currentObject.traverse((child) => {
    child.visible = true;
    if (!child.isMesh) {
      return;
    }
    child.frustumCulled = false;
    child.castShadow = false;
    child.receiveShadow = false;
    if (child.geometry) {
      const drawCount = child.geometry.index?.count || child.geometry.attributes?.position?.count || Infinity;
      child.geometry.setDrawRange(0, drawCount);
      if (!child.geometry.attributes.normal) {
        child.geometry.computeVertexNormals();
      }
    }
    if (
      (materialMode === "auto" || materialMode === "basecolor") &&
      state.currentTexture
    ) {
      child.material = createBasecolorMaterial(state.currentTexture);
      return;
    }
    if (materialMode === "source" || materialMode === "auto") {
      child.material = cloneSourceMaterial(state.originalMaterials.get(child.uuid));
      return;
    }
    child.material = createClayMaterial();
  });
  rebuildGeometryOverlay();
}

function disposeMaterial(material) {
  if (Array.isArray(material)) {
    material.forEach((item) => item?.dispose?.());
    return;
  }
  material?.dispose?.();
}

function removeGeometryOverlay(object) {
  const overlays = [];
  object?.traverse((child) => {
    if (child.name === GEOMETRY_OVERLAY_NAME) {
      overlays.push(child);
    }
  });
  overlays.forEach((overlay) => {
    overlay.parent?.remove(overlay);
    overlay.geometry?.dispose?.();
    disposeMaterial(overlay.material);
  });
}

function rebuildGeometryOverlay() {
  if (!state.currentObject) {
    return;
  }
  removeGeometryOverlay(state.currentObject);
  const meshes = [];
  state.currentObject.traverse((child) => {
    if (child.isMesh && child.geometry?.attributes?.position) {
      meshes.push(child);
    }
  });
  meshes.forEach((mesh) => {
    const points = new THREE.Points(
      mesh.geometry,
      new THREE.PointsMaterial({
        color: 0xeaf0e9,
        depthTest: false,
        opacity: 0.68,
        size: 2,
        sizeAttenuation: false,
        transparent: true,
      }),
    );
    points.name = GEOMETRY_OVERLAY_NAME;
    points.frustumCulled = false;
    mesh.add(points);
  });
}

function clearModel() {
  if (state.currentObject) {
    removeGeometryOverlay(state.currentObject);
    modelRoot.remove(state.currentObject);
    state.currentObject.traverse((child) => {
      if (child.isMesh) {
        child.geometry?.dispose?.();
        disposeMaterial(child.material);
      }
    });
  }
  state.currentObject = null;
  state.originalMaterials.clear();
}

function disposeObject3D(object) {
  object.traverse((child) => {
    child.geometry?.dispose?.();
    disposeMaterial(child.material);
  });
}

function getArrayValue(bytes, typeCode, length) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (typeCode === "d") {
    return new Float64Array(buffer, 0, length);
  }
  if (typeCode === "f") {
    return new Float32Array(buffer, 0, length);
  }
  if (typeCode === "i") {
    return new Int32Array(buffer, 0, length);
  }
  if (typeCode === "l") {
    return new BigInt64Array(buffer, 0, length);
  }
  if (typeCode === "b") {
    return new Int8Array(buffer, 0, length);
  }
  return bytes;
}

function readBinaryFbxArray(view, bytes, offset, typeCode) {
  const length = view.getUint32(offset, true);
  const encoding = view.getUint32(offset + 4, true);
  const compressedLength = view.getUint32(offset + 8, true);
  const dataStart = offset + 12;
  let raw = bytes.slice(dataStart, dataStart + compressedLength);
  if (encoding === 1) {
    raw = decompressSync(raw);
  } else if (encoding !== 0) {
    throw new Error(`Unsupported FBX array encoding ${encoding}.`);
  }
  return {
    nextOffset: dataStart + compressedLength,
    value: getArrayValue(raw, typeCode, length),
  };
}

function skipBinaryFbxProperty(view, bytes, offset) {
  const typeCode = String.fromCharCode(view.getUint8(offset));
  offset += 1;
  if (typeCode === "C") {
    return { nextOffset: offset + 1, value: null };
  }
  if (typeCode === "Y") {
    return { nextOffset: offset + 2, value: null };
  }
  if (typeCode === "I" || typeCode === "F") {
    return { nextOffset: offset + 4, value: null };
  }
  if (typeCode === "D" || typeCode === "L") {
    return { nextOffset: offset + 8, value: null };
  }
  if (typeCode === "R" || typeCode === "S") {
    const length = view.getUint32(offset, true);
    return { nextOffset: offset + 4 + length, value: null };
  }
  if ("bcilfd".includes(typeCode)) {
    return readBinaryFbxArray(view, bytes, offset, typeCode);
  }
  throw new Error(`Unsupported FBX property type ${typeCode}.`);
}

function parseBinaryFbxGeometries(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const version = view.getUint32(23, true);
  const wideOffsets = version >= 7500;
  const decoder = new TextDecoder();
  const geometries = [];

  function readNode(offset, activeGeometry = null) {
    const startOffset = offset;
    let endOffset;
    let propertyCount;
    let propertyListLength;
    if (wideOffsets) {
      endOffset = Number(view.getBigUint64(offset, true));
      propertyCount = Number(view.getBigUint64(offset + 8, true));
      propertyListLength = Number(view.getBigUint64(offset + 16, true));
      offset += 24;
    } else {
      endOffset = view.getUint32(offset, true);
      propertyCount = view.getUint32(offset + 4, true);
      propertyListLength = view.getUint32(offset + 8, true);
      offset += 12;
    }
    const nameLength = view.getUint8(offset);
    offset += 1;
    if (!endOffset && !propertyCount && !propertyListLength && !nameLength) {
      return { nextOffset: offset, isNull: true };
    }
    const name = decoder.decode(bytes.slice(offset, offset + nameLength));
    offset += nameLength;
    const geometry = name === "Geometry" ? { vertices: null, polygonIndices: null } : activeGeometry;
    const properties = [];
    for (let index = 0; index < propertyCount; index += 1) {
      const result = skipBinaryFbxProperty(view, bytes, offset);
      offset = result.nextOffset;
      properties.push(result.value);
    }
    if (geometry && name === "Vertices") {
      geometry.vertices = properties[0];
    }
    if (geometry && name === "PolygonVertexIndex") {
      geometry.polygonIndices = properties[0];
    }
    while (offset < endOffset) {
      const child = readNode(offset, geometry);
      offset = child.nextOffset;
      if (child.isNull) {
        break;
      }
    }
    if (name === "Geometry" && geometry.vertices) {
      geometries.push(geometry);
    }
    return { nextOffset: endOffset || startOffset, isNull: false };
  }

  let offset = 27;
  while (offset < bytes.byteLength) {
    const node = readNode(offset, null);
    offset = node.nextOffset;
    if (node.isNull) {
      break;
    }
  }
  return geometries;
}

function copyVerticesToFloat32(geometries) {
  const vertexCount = geometries.reduce(
    (total, geometry) => total + Math.floor((geometry.vertices?.length || 0) / 3),
    0,
  );
  const positions = new Float32Array(vertexCount * 3);
  let writeOffset = 0;
  geometries.forEach((geometry) => {
    for (let index = 0; index < geometry.vertices.length; index += 1) {
      positions[writeOffset] = geometry.vertices[index];
      writeOffset += 1;
    }
  });
  return { positions, vertexCount };
}

function appendWireSegment(linePositions, vertices, fromIndex, toIndex) {
  const start = linePositions.length;
  linePositions.length = start + 6;
  linePositions[start] = vertices[fromIndex * 3];
  linePositions[start + 1] = vertices[fromIndex * 3 + 1];
  linePositions[start + 2] = vertices[fromIndex * 3 + 2];
  linePositions[start + 3] = vertices[toIndex * 3];
  linePositions[start + 4] = vertices[toIndex * 3 + 1];
  linePositions[start + 5] = vertices[toIndex * 3 + 2];
}

function buildWirePositions(geometries) {
  const linePositions = [];
  let segmentCount = 0;
  for (const geometry of geometries) {
    const vertices = geometry.vertices;
    const polygonIndices = geometry.polygonIndices;
    if (!vertices || !polygonIndices) {
      continue;
    }
    let loop = [];
    for (let index = 0; index < polygonIndices.length; index += 1) {
      const rawIndex = polygonIndices[index];
      const vertexIndex = rawIndex < 0 ? -rawIndex - 1 : rawIndex;
      loop.push(vertexIndex);
      if (rawIndex >= 0) {
        continue;
      }
      if (loop.length > 1) {
        for (let loopIndex = 0; loopIndex < loop.length; loopIndex += 1) {
          const fromIndex = loop[loopIndex];
          const toIndex = loop[(loopIndex + 1) % loop.length];
          appendWireSegment(linePositions, vertices, fromIndex, toIndex);
          segmentCount += 1;
          if (segmentCount >= MAX_WIRE_SEGMENTS) {
            return { positions: new Float32Array(linePositions), segmentCount };
          }
        }
      }
      loop = [];
    }
  }
  return { positions: new Float32Array(linePositions), segmentCount };
}

function createBinaryFbxPreview(arrayBuffer) {
  const geometries = parseBinaryFbxGeometries(arrayBuffer);
  if (!geometries.length) {
    throw new Error("No FBX Geometry/Vertices nodes found.");
  }
  const preview = new THREE.Group();
  preview.name = "binary-fbx-preview";
  const { positions, vertexCount } = copyVerticesToFloat32(geometries);
  const pointsGeometry = new THREE.BufferGeometry();
  pointsGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  pointsGeometry.computeBoundingSphere();
  const points = new THREE.Points(
    pointsGeometry,
    new THREE.PointsMaterial({
      color: 0x087e6b,
      depthTest: false,
      opacity: 0.55,
      size: 2,
      sizeAttenuation: false,
      transparent: true,
    }),
  );
  points.frustumCulled = false;
  preview.add(points);

  const wire = buildWirePositions(geometries);
  if (wire.segmentCount) {
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute("position", new THREE.BufferAttribute(wire.positions, 3));
    lineGeometry.computeBoundingSphere();
    const lines = new THREE.LineSegments(
      lineGeometry,
      new THREE.LineBasicMaterial({
        color: 0x1d2622,
        depthTest: false,
        opacity: 0.26,
        transparent: true,
      }),
    );
    lines.frustumCulled = false;
    preview.add(lines);
  }
  preview.userData.previewMeshCount = geometries.length;
  preview.userData.previewVertexCount = vertexCount;
  preview.userData.previewSegmentCount = wire.segmentCount;
  return preview;
}

function normalizeModel(object) {
  object.position.set(0, 0, 0);
  object.rotation.set(0, 0, 0);
  object.scale.set(1, 1, 1);
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  let scale = 1;
  if (maxDimension > 0) {
    scale = 3 / maxDimension;
  }
  object.scale.setScalar(scale);
  object.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
  object.updateMatrixWorld(true);
  state.baseBox.copy(new THREE.Box3().setFromObject(object));
  const normalizedSize = state.baseBox.getSize(new THREE.Vector3());
  state.orthoSize = Math.max(normalizedSize.x, normalizedSize.y, normalizedSize.z, 1) * 1.35;
}

function getMeshCount(object) {
  if (object?.userData?.previewMeshCount) {
    return object.userData.previewMeshCount;
  }
  let meshCount = 0;
  object?.traverse((child) => {
    if (child.isMesh) {
      meshCount += 1;
    }
  });
  return meshCount;
}

function getVertexCount(object) {
  if (object?.userData?.previewVertexCount) {
    return object.userData.previewVertexCount;
  }
  let vertexCount = 0;
  object?.traverse((child) => {
    if (child.isMesh && child.geometry?.attributes?.position) {
      vertexCount += child.geometry.attributes.position.count;
    }
  });
  return vertexCount;
}

function updateModelMeta() {
  const size = state.baseBox.getSize(new THREE.Vector3());
  elements.fbxMeta.textContent = state.currentFbxName || "None";
  elements.textureMeta.textContent = state.currentTextureName || "None";
  elements.meshMeta.textContent = String(getMeshCount(state.currentObject));
  elements.vertexMeta.textContent = String(getVertexCount(state.currentObject));
  elements.boundsMeta.textContent = `${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`;
}

function getPoseFromInputs() {
  return normalizeViewerPose({
    modelYaw: elements.poseInputs.modelYaw.value,
    modelPitch: elements.poseInputs.modelPitch.value,
    modelRoll: elements.poseInputs.modelRoll.value,
    cameraYaw: elements.poseInputs.cameraYaw.value,
    cameraPitch: elements.poseInputs.cameraPitch.value,
    cameraRoll: elements.poseInputs.cameraRoll.value,
  });
}

function setPoseInputs(pose) {
  Object.entries(elements.poseInputs).forEach(([key, input]) => {
    input.value = String(Math.round(finiteNumber(pose[key])));
  });
}

function syncPoseOutputs() {
  Object.entries(elements.poseOutputs).forEach(([key, output]) => {
    output.textContent = `${Math.round(finiteNumber(state.pose[key]))} deg`;
  });
}

function applyModelPose() {
  if (!state.currentObject) {
    return;
  }
  state.currentObject.rotation.set(
    degreesToRadians(state.pose.modelPitch),
    degreesToRadians(state.pose.modelYaw),
    degreesToRadians(state.pose.modelRoll),
  );
  state.currentObject.updateMatrixWorld(true);
}

function getBaseViewPosition() {
  if (state.viewPreset === "frontY") {
    return new THREE.Vector3(0, -VIEW_DISTANCE, 0);
  }
  if (state.viewPreset === "sideX") {
    return new THREE.Vector3(VIEW_DISTANCE, 0, 0);
  }
  if (state.viewPreset === "threeQuarter") {
    return new THREE.Vector3(VIEW_DISTANCE * 0.65, VIEW_DISTANCE * 0.45, VIEW_DISTANCE * 0.65);
  }
  return new THREE.Vector3(0, 0, VIEW_DISTANCE);
}

function applyCameraPose() {
  const basePosition = getBaseViewPosition();
  const euler = new THREE.Euler(
    degreesToRadians(state.pose.cameraPitch),
    degreesToRadians(state.pose.cameraYaw),
    0,
    "YXZ",
  );
  basePosition.applyEuler(euler);
  camera.position.copy(basePosition);
  const up = new THREE.Vector3(0, 1, 0);
  if (state.viewPreset === "frontY") {
    up.set(0, 0, 1);
  }
  const viewDirection = new THREE.Vector3().subVectors(new THREE.Vector3(0, 0, 0), camera.position).normalize();
  up.applyAxisAngle(viewDirection, degreesToRadians(state.pose.cameraRoll));
  camera.up.copy(up);
  camera.lookAt(0, 0, 0);
  controls.target.set(0, 0, 0);
  controls.update();
}

function updateCameraFrustum() {
  const width = elements.canvas.clientWidth || 1;
  const height = elements.canvas.clientHeight || 1;
  const aspect = width / height;
  const halfHeight = state.orthoSize / 2;
  const halfWidth = halfHeight * aspect;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.near = 0.01;
  camera.far = 100;
  camera.updateProjectionMatrix();
}

function updateHelpers() {
  helperRoot.visible = elements.helpersToggle.checked;
  if (!state.currentObject) {
    boxHelper.visible = false;
    return;
  }
  const box = new THREE.Box3().setFromObject(state.currentObject);
  boxHelper.box.copy(box);
  boxHelper.visible = true;
}

function updatePoseJson() {
  const config = {
    fbx: state.currentFbxSource,
    texture: state.currentTextureName,
    materialMode: elements.materialModeSelect.value,
    viewPreset: state.viewPreset,
    poseDegrees: state.pose,
    orthographic: {
      size: Number(state.orthoSize.toFixed(4)),
    },
  };
  elements.poseJsonOutput.value = JSON.stringify(config, null, 2);
}

function syncView() {
  state.pose = getPoseFromInputs();
  setPoseInputs(state.pose);
  syncPoseOutputs();
  applyModelPose();
  applyCameraPose();
  updateCameraFrustum();
  updateHelpers();
  updatePoseJson();
}

function fitModel() {
  if (!state.currentObject) {
    setStatus("Load an FBX before fitting.", true);
    return;
  }
  const box = new THREE.Box3().setFromObject(state.currentObject);
  const size = box.getSize(new THREE.Vector3());
  state.orthoSize = Math.max(size.x, size.y, size.z, 1) * 1.35;
  syncView();
  setStatus("Model fitted.");
}

async function applyTextureFromUrl(textureUrl) {
  const trimmedUrl = textureUrl.trim();
  if (!trimmedUrl) {
    state.currentTexture = null;
    state.currentTextureName = "";
    applyMaterials();
    updateModelMeta();
    syncView();
    return;
  }
  const texture = await loadTexture(trimmedUrl);
  state.currentTexture = texture;
  state.currentTextureName = trimmedUrl;
  applyMaterials();
  updateModelMeta();
  syncView();
}

async function loadFbxFromBuffer(arrayBuffer, sourceName, sourceUrl = sourceName) {
  setLoading(true);
  setStatus(`Loading ${sourceName}...`);
  try {
    const loader = new FBXLoader();
    const loaderObject = loader.parse(arrayBuffer, "");
    const object = createBinaryFbxPreview(arrayBuffer);
    clearModel();
    state.currentObject = object;
    state.currentFbxName = getFileNameFromPath(sourceName);
    state.currentFbxSource = sourceUrl;
    rememberOriginalMaterials(loaderObject);
    normalizeModel(object);
    modelRoot.add(object);
    updateModelMeta();
    syncView();
    setStatus(`Loaded ${state.currentFbxName}.`);
    disposeObject3D(loaderObject);
  } catch (error) {
    console.error(error);
    setStatus(`FBX load failed: ${error.message || "Unknown error"}.`, true);
  } finally {
    setLoading(false);
  }
}

async function loadFbxFromUrl(fbxUrl, textureUrl = "") {
  setLoading(true);
  setStatus(`Fetching ${fbxUrl}...`);
  let textureLoadError = null;
  try {
    const response = await fetch(fbxUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    if (textureUrl.trim()) {
      try {
        await applyTextureFromUrl(textureUrl);
      } catch (error) {
        console.warn("Texture could not be loaded.", error);
        state.currentTexture = null;
        state.currentTextureName = "";
        textureLoadError = error;
      }
    } else {
      state.currentTexture = null;
      state.currentTextureName = "";
    }
    await loadFbxFromBuffer(arrayBuffer, fbxUrl, fbxUrl);
    if (textureLoadError) {
      setStatus("FBX loaded, but Basecolor texture could not be loaded.", true);
    }
  } catch (error) {
    console.error(error);
    setStatus(`URL load failed: ${error.message || "Unknown error"}.`, true);
  } finally {
    setLoading(false);
  }
}

function autoFillTextureUrl() {
  const textureUrl = buildBasecolorUrlForFbxName(elements.fbxUrlInput.value, DEFAULT_TEXTURE_ROOT);
  elements.textureUrlInput.value = textureUrl;
  setStatus(textureUrl ? "Basecolor URL inferred." : "No numeric FBX id found.", !textureUrl);
}

async function handleFbxFile(file) {
  if (!file) {
    return;
  }
  const arrayBuffer = await file.arrayBuffer();
  await loadFbxFromBuffer(arrayBuffer, file.name, file.name);
}

async function handleTextureFile(file) {
  if (!file) {
    return;
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    await applyTextureFromUrl(objectUrl);
    state.currentTextureName = file.name;
    updateModelMeta();
    setStatus(`Texture loaded: ${file.name}.`);
  } catch (error) {
    console.error(error);
    setStatus(`Texture load failed: ${error.message || "Unknown error"}.`, true);
  }
}

function setViewPreset(viewPreset) {
  state.viewPreset = viewPreset;
  syncView();
  setStatus(`View preset: ${viewPreset}.`);
}

function zeroPose() {
  setPoseInputs({
    modelYaw: 0,
    modelPitch: 0,
    modelRoll: 0,
    cameraYaw: 0,
    cameraPitch: 0,
    cameraRoll: 0,
  });
  syncView();
  setStatus("Pose reset.");
}

function samplePose() {
  setPoseInputs({
    modelYaw: randomInteger(-12, 12),
    modelPitch: randomInteger(-10, 10),
    modelRoll: randomInteger(-5, 5),
    cameraYaw: randomInteger(-8, 8),
    cameraPitch: randomInteger(-8, 8),
    cameraRoll: randomInteger(-3, 3),
  });
  syncView();
  setStatus("Sampled a bounded pose.");
}

function randomInteger(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function exportPng() {
  if (!state.currentObject) {
    setStatus("Load an FBX before exporting.", true);
    return;
  }
  renderer.render(scene, camera);
  elements.canvas.toBlob((blob) => {
    if (!blob) {
      setStatus("PNG export failed.", true);
      return;
    }
    const link = document.createElement("a");
    const baseName = state.currentFbxName.replace(/\.[^.]+$/, "") || "fbx-render";
    link.href = URL.createObjectURL(blob);
    link.download = `${baseName}_orthographic.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    setStatus("PNG exported.");
  }, "image/png");
}

function resizeRenderer() {
  const rect = elements.canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const currentSize = renderer.getSize(new THREE.Vector2());
  if (currentSize.x !== width || currentSize.y !== height) {
    renderer.setSize(width, height, false);
    updateCameraFrustum();
  }
}

function animate() {
  resizeRenderer();
  controls.update();
  updateHelpers();
  renderer.render(scene, camera);
}

function wireEvents() {
  elements.loadNumericSampleButton.addEventListener("click", () => {
    elements.fbxUrlInput.value = DEFAULT_NUMERIC_FBX_URL;
    autoFillTextureUrl();
    loadFbxFromUrl(elements.fbxUrlInput.value, elements.textureUrlInput.value);
  });
  elements.loadNamedSampleButton.addEventListener("click", () => {
    elements.fbxUrlInput.value = DEFAULT_NAMED_FBX_URL;
    elements.textureUrlInput.value = "";
    loadFbxFromUrl(elements.fbxUrlInput.value, "");
  });
  elements.loadUrlButton.addEventListener("click", () => {
    loadFbxFromUrl(elements.fbxUrlInput.value.trim(), elements.textureUrlInput.value.trim());
  });
  elements.autoTextureButton.addEventListener("click", autoFillTextureUrl);
  elements.fbxFileInput.addEventListener("change", (event) => {
    handleFbxFile(event.target.files[0]).catch((error) => {
      console.error(error);
      setStatus("FBX file could not be read.", true);
    });
    event.target.value = "";
  });
  elements.textureFileInput.addEventListener("change", (event) => {
    handleTextureFile(event.target.files[0]).catch((error) => {
      console.error(error);
      setStatus("Texture file could not be read.", true);
    });
    event.target.value = "";
  });
  elements.materialModeSelect.addEventListener("change", () => {
    applyMaterials();
    syncView();
  });
  elements.wireframeToggle.addEventListener("change", () => {
    applyMaterials();
    syncView();
  });
  elements.helpersToggle.addEventListener("change", syncView);
  elements.fitButton.addEventListener("click", fitModel);
  elements.exportPngButton.addEventListener("click", exportPng);
  elements.zeroPoseButton.addEventListener("click", zeroPose);
  elements.samplePoseButton.addEventListener("click", samplePose);
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setViewPreset(button.dataset.view));
  });
  Object.values(elements.poseInputs).forEach((input) => {
    input.addEventListener("input", syncView);
  });
  window.addEventListener("resize", syncView);
}

wireEvents();
syncView();
renderer.setAnimationLoop(animate);
setStatus("Ready. Load a sample or open an FBX file.");
