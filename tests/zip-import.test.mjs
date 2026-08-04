import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { MAX_ZIP_ENTRY_BYTES } from "../src/config.js";
import {
  ZIP_IMPORT_ERROR_CODES,
  ZipImportError,
  readImageSourcesFromZip,
} from "../src/zip-import.js";

const require = createRequire(import.meta.url);
const fflate = require("../vendor/fflate-0.8.3.js");
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

class InlineAsyncInflate {
  constructor(callback) {
    this.callback = callback;
    this.inflate = new fflate.Inflate((chunk, final) => callback(null, chunk, final));
  }

  push(chunk, final) {
    try {
      this.inflate.push(chunk, final);
    } catch (error) {
      this.callback(error, null, final);
    }
  }

  terminate() {}
}

const inlineInflateLibrary = { ...fflate, AsyncInflate: InlineAsyncInflate };

function makeZipBytes(entries, options = { level: 0 }) {
  return fflate.zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([path, value]) => [
        path,
        value instanceof Uint8Array ? value : fflate.strToU8(value),
      ]),
    ),
    options,
  );
}

function makeZipFile(entries, name = "images.zip", options) {
  return new File([makeZipBytes(entries, options)], name, {
    type: "application/zip",
    lastModified: 100,
  });
}

function fileFromBytes(bytes, name = "mutated.zip") {
  return new File([bytes], name, { type: "application/zip", lastModified: 100 });
}

function joinChunks(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return joined;
}

function makeDataDescriptorZip() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const zip = new fflate.Zip((error, chunk, final) => {
      if (error) {
        reject(error);
        return;
      }
      chunks.push(chunk);
      if (final) {
        resolve(joinChunks(chunks));
      }
    });
    const entry = new fflate.ZipDeflate("batch/descriptor.jpg", { level: 6 });
    zip.add(entry);
    entry.push(fflate.strToU8("descriptor payload"), true);
    zip.end();
  });
}

function readUint16(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readUint32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function writeUint16(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

function writeUint32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function findEocd(bytes) {
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (readUint32(bytes, offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("EOCD not found in test fixture.");
}

function readEntryLocations(bytes) {
  const eocd = findEocd(bytes);
  const count = readUint16(bytes, eocd + 10);
  let cursor = readUint32(bytes, eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(readUint32(bytes, cursor), CENTRAL_SIGNATURE);
    const nameLength = readUint16(bytes, cursor + 28);
    const extraLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);
    const localOffset = readUint32(bytes, cursor + 42);
    const localNameLength = readUint16(bytes, localOffset + 26);
    const localExtraLength = readUint16(bytes, localOffset + 28);
    entries.push({
      centralOffset: cursor,
      localOffset,
      dataOffset: localOffset + 30 + localNameLength + localExtraLength,
      name: fflate.strFromU8(bytes.subarray(cursor + 46, cursor + 46 + nameLength)),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function assertZipError(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error instanceof ZipImportError, true);
    assert.equal(error.code, code);
    return true;
  });
}

async function testReadsImagesAndStripsSharedRoot() {
  const file = makeZipFile({
    "batch/10.jpg": "ten",
    "batch/2.png": "two",
    "batch/nested/3.webp": "three",
    "batch/readme.txt": "ignored",
  });
  const sources = await readImageSourcesFromZip(file, { zipLibrary: fflate });

  assert.deepEqual(sources.map((source) => source.path), ["2.png", "10.jpg", "nested/3.webp"]);
  assert.deepEqual(sources.map((source) => source.file.type), [
    "image/png",
    "image/jpeg",
    "image/webp",
  ]);
}

async function testRejectsNoImagesAndUnsafePaths() {
  await assertZipError(
    () => readImageSourcesFromZip(makeZipFile({ "notes.txt": "none" }), {
      zipLibrary: fflate,
    }),
    ZIP_IMPORT_ERROR_CODES.NO_IMAGES,
  );
  await assertZipError(
    () => readImageSourcesFromZip(makeZipFile({ "../escape.jpg": "bad" }), {
      zipLibrary: fflate,
    }),
    ZIP_IMPORT_ERROR_CODES.UNSAFE_PATH,
  );
}

async function testRejectsDuplicatePortablePaths() {
  await assertZipError(
    () => readImageSourcesFromZip(makeZipFile({
      "batch/A.jpg": "one",
      "batch/a.JPG": "two",
    }), { zipLibrary: fflate }),
    ZIP_IMPORT_ERROR_CODES.DUPLICATE_PATH,
  );
}

async function testRejectsCorruptArchive() {
  const file = new File([new Uint8Array([1, 2, 3, 4])], "broken.zip", {
    type: "application/zip",
  });
  await assertZipError(
    () => readImageSourcesFromZip(file, { zipLibrary: fflate }),
    ZIP_IMPORT_ERROR_CODES.INVALID_FILE,
  );
}

async function testRejectsEncryptionFlagsAndAesMethod() {
  const encrypted = makeZipBytes({ "batch/a.jpg": "safe" });
  const [encryptedEntry] = readEntryLocations(encrypted);
  writeUint16(
    encrypted,
    encryptedEntry.centralOffset + 8,
    readUint16(encrypted, encryptedEntry.centralOffset + 8) | 1,
  );
  writeUint16(
    encrypted,
    encryptedEntry.localOffset + 6,
    readUint16(encrypted, encryptedEntry.localOffset + 6) | 1,
  );
  await assertZipError(
    () => readImageSourcesFromZip(fileFromBytes(encrypted), { zipLibrary: fflate }),
    ZIP_IMPORT_ERROR_CODES.ENCRYPTED,
  );

  const localOnly = makeZipBytes({ "batch/a.jpg": "safe" });
  const [localOnlyEntry] = readEntryLocations(localOnly);
  writeUint16(
    localOnly,
    localOnlyEntry.localOffset + 6,
    readUint16(localOnly, localOnlyEntry.localOffset + 6) | 1,
  );
  await assertZipError(
    () => readImageSourcesFromZip(fileFromBytes(localOnly), { zipLibrary: fflate }),
    ZIP_IMPORT_ERROR_CODES.ENCRYPTED,
  );

  const aes = makeZipBytes({ "batch/a.jpg": "safe" });
  const [aesEntry] = readEntryLocations(aes);
  writeUint16(aes, aesEntry.centralOffset + 10, 99);
  writeUint16(aes, aesEntry.localOffset + 8, 99);
  await assertZipError(
    () => readImageSourcesFromZip(fileFromBytes(aes), { zipLibrary: fflate }),
    ZIP_IMPORT_ERROR_CODES.ENCRYPTED,
  );

  const aesExtra = fflate.zipSync({
    "batch/a.jpg": [
      fflate.strToU8("safe"),
      {
        level: 0,
        extra: { 39169: Uint8Array.of(2, 0, 0x41, 0x45, 3, 0, 0) },
      },
    ],
  });
  await assertZipError(
    () => readImageSourcesFromZip(fileFromBytes(aesExtra), { zipLibrary: fflate }),
    ZIP_IMPORT_ERROR_CODES.ENCRYPTED,
  );
}

async function testReadsDataDescriptorArchive() {
  const bytes = await makeDataDescriptorZip();
  const sources = await readImageSourcesFromZip(fileFromBytes(bytes), {
    zipLibrary: inlineInflateLibrary,
  });

  assert.deepEqual(sources.map((source) => source.path), ["descriptor.jpg"]);
  assert.equal(await sources[0].file.text(), "descriptor payload");
}

async function testRejectsStoredSizeMismatchBeforeCreatingOutputFiles() {
  const bytes = makeZipBytes({ "batch/a.jpg": "four" });
  const [entry] = readEntryLocations(bytes);
  writeUint32(bytes, entry.centralOffset + 24, 1);
  writeUint32(bytes, entry.localOffset + 22, 1);

  const NativeFile = globalThis.File;
  let createdOutputFiles = 0;
  globalThis.File = class CountingFile extends NativeFile {
    constructor(...args) {
      super(...args);
      createdOutputFiles += 1;
    }
  };
  try {
    await assertZipError(
      () => readImageSourcesFromZip(fileFromBytes(bytes), { zipLibrary: fflate }),
      ZIP_IMPORT_ERROR_CODES.INVALID_FILE,
    );
  } finally {
    globalThis.File = NativeFile;
  }
  assert.equal(createdOutputFiles, 1, "only the archive File should have been constructed");
}

async function testRejectsUnsupportedMethodAndOverlappingEntries() {
  const unsupported = makeZipBytes({ "batch/a.jpg": "safe" });
  const [unsupportedEntry] = readEntryLocations(unsupported);
  writeUint16(unsupported, unsupportedEntry.centralOffset + 10, 12);
  writeUint16(unsupported, unsupportedEntry.localOffset + 8, 12);
  await assertZipError(
    () => readImageSourcesFromZip(fileFromBytes(unsupported), { zipLibrary: fflate }),
    ZIP_IMPORT_ERROR_CODES.UNSUPPORTED_COMPRESSION,
  );

  const overlapping = makeZipBytes({
    "batch/a.jpg": "one",
    "batch/b.jpg": "two",
  });
  const [first, second] = readEntryLocations(overlapping);
  writeUint32(overlapping, second.centralOffset + 42, first.localOffset);
  await assertZipError(
    () => readImageSourcesFromZip(fileFromBytes(overlapping), { zipLibrary: fflate }),
    ZIP_IMPORT_ERROR_CODES.INVALID_FILE,
  );
}

async function testRejectsDeclaredLimitAndCrcMismatch() {
  const oversized = makeZipBytes({ "batch/a.jpg": "safe" }, { level: 6 });
  const [oversizedEntry] = readEntryLocations(oversized);
  writeUint32(oversized, oversizedEntry.centralOffset + 24, MAX_ZIP_ENTRY_BYTES + 1);
  writeUint32(oversized, oversizedEntry.localOffset + 22, MAX_ZIP_ENTRY_BYTES + 1);
  await assertZipError(
    () => readImageSourcesFromZip(fileFromBytes(oversized), { zipLibrary: fflate }),
    ZIP_IMPORT_ERROR_CODES.LIMIT_EXCEEDED,
  );

  const corruptPayload = makeZipBytes({ "batch/a.jpg": "safe" });
  const [corruptEntry] = readEntryLocations(corruptPayload);
  corruptPayload[corruptEntry.dataOffset] ^= 0xff;
  await assertZipError(
    () => readImageSourcesFromZip(fileFromBytes(corruptPayload), { zipLibrary: fflate }),
    ZIP_IMPORT_ERROR_CODES.INVALID_FILE,
  );
}

async function testRejectsActualInflatedSizeBeyondDeclaration() {
  const bytes = makeZipBytes({ "batch/a.jpg": "actual output" }, { level: 6 });
  const [entry] = readEntryLocations(bytes);
  writeUint32(bytes, entry.centralOffset + 24, 1);
  writeUint32(bytes, entry.localOffset + 22, 1);
  let terminated = false;
  class FakeAsyncInflate {
    constructor(callback) {
      this.callback = callback;
    }

    push(_chunk, final) {
      this.callback(null, final ? fflate.strToU8("actual output") : new Uint8Array(), final);
    }

    terminate() {
      terminated = true;
    }
  }
  await assertZipError(
    () => readImageSourcesFromZip(fileFromBytes(bytes), {
      zipLibrary: { ...fflate, AsyncInflate: FakeAsyncInflate },
    }),
    ZIP_IMPORT_ERROR_CODES.INVALID_FILE,
  );
  assert.equal(terminated, true);
}

await testReadsImagesAndStripsSharedRoot();
await testRejectsNoImagesAndUnsafePaths();
await testRejectsDuplicatePortablePaths();
await testRejectsCorruptArchive();
await testRejectsEncryptionFlagsAndAesMethod();
await testReadsDataDescriptorArchive();
await testRejectsStoredSizeMismatchBeforeCreatingOutputFiles();
await testRejectsUnsupportedMethodAndOverlappingEntries();
await testRejectsDeclaredLimitAndCrcMismatch();
await testRejectsActualInflatedSizeBeyondDeclaration();

console.log("zip import tests passed");
