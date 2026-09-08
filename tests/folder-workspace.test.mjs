import assert from "node:assert/strict";
import { scanImageDirectory, validateFolderImage, ensureFolderPermission, FOLDER_IMAGE_KIND } from "../src/folder-workspace.js";

function directory(entries = []) {
  return { kind: "directory", async *entries() { yield* entries; } };
}
const image = () => ({ kind: "file", getFile() { throw new Error("Directory scan must not read image contents"); } });
const sources = await scanImageDirectory(directory([
  ["10.jpg", image()], ["2.jpg", image()], ["readme.txt", image()],
  ["sub", directory([["photo.png", image()]])],
]));
assert.deepEqual(sources.map(({ path }) => path), ["2.jpg", "10.jpg", "sub/photo.png"]);
await assert.rejects(scanImageDirectory(directory()), { code: "FOLDER_EMPTY" });
await assert.rejects(scanImageDirectory(directory([["same.JPG", image()], ["Same.jpg", image()]])), { code: "FOLDER_DUPLICATE" });
await assert.rejects(scanImageDirectory(directory([["../bad.jpg", image()]])), /unsafe segment/);
await assert.rejects(scanImageDirectory(directory([["a.jpg", image()], ["a.jpg.json", directory([["b.jpg", image()]])]])), { code: "FOLDER_DUPLICATE" });
const lots = Array.from({ length: 10000 }, (_, index) => [`${index}.jpg`, image()]);
assert.equal((await scanImageDirectory(directory(lots))).length, 10000);
await assert.rejects(scanImageDirectory(directory([...lots, ["extra.jpg", image()]])), { code: "FOLDER_LIMIT" });

function record() {
  return {
    kind: FOLDER_IMAGE_KIND, version: 1, relativePath: "photo.jpg", width: 100, height: 100, status: "in_progress",
    source: { size: 123, sha256: "a".repeat(64) }, revision: "revision-1",
    contours: [{ id: "a", label: "left_eyebrow", closed: false, points: [{ x: 2.25, y: 4.5 }, { x: 20.75, y: 40 }] }],
    draft: { label: "face_outline", closed: true, points: [{ x: 1.5, y: 2 }] },
  };
}
const value = record();
assert.deepEqual(validateFolderImage({ data: value, path: "photo.jpg" }).contours, value.contours);
assert.deepEqual(validateFolderImage({ data: value, path: "photo.jpg" }).draft, value.draft);
assert.throws(() => validateFolderImage({ data: value, path: "other.jpg" }), { code: "FOLDER_INVALID_RECORD" });
for (const mutate of [
  (data) => { data.version = 2; },
  (data) => { data.width = 0; },
  (data) => { data.status = "invalid"; },
  (data) => { data.contours[0].points[0].x = NaN; },
  (data) => { data.contours[0].points[0].x = 101; },
  (data) => { data.contours.push(data.contours[0]); },
  (data) => { data.draft.points[0].y = -1; },
  (data) => { data.draft.label = "left_eyebrow"; data.draft.closed = true; },
  (data) => { data.status = "done"; data.contours = []; },
]) {
  const invalid = record(); mutate(invalid);
  assert.throws(() => validateFolderImage({ data: invalid, path: "photo.jpg" }));
}
let requests = 0;
const handle = { kind: "directory", queryPermission: async () => "prompt", requestPermission: async ({ mode }) => { assert.equal(mode, "readwrite"); requests += 1; return "granted"; } };
await assert.rejects(ensureFolderPermission({ handle, mode: "readwrite" }), { code: "FOLDER_PERMISSION" });
assert.equal(requests, 0, "Refresh must not request a permission without a gesture");
await ensureFolderPermission({ handle, mode: "readwrite", request: true });
assert.equal(requests, 1);
console.log("folder workspace boundary tests passed");
