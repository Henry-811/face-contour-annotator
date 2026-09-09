import {
  MAX_IMAGE_SET_ENTRIES,
  MAX_ZIP_COMPRESSION_RATIO,
  MAX_ZIP_ENTRY_BYTES,
  MAX_ZIP_EXPANDED_BYTES,
  MAX_ZIP_FILE_BYTES,
  MAX_ZIP_INFLATE_CONCURRENCY,
  ZIP_INFLATE_INPUT_CHUNK_BYTES,
} from "./config.js?v=workspace-ux-2";
import {
  normalizeAnnotationRelativePath,
  stripSharedRootDirectory,
} from "./annotation-transfer.js?v=workspace-ux-2";

const IMAGE_MIME_TYPES = Object.freeze({
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
});

const ZIP_SIGNATURES = Object.freeze({
  LOCAL_FILE: 0x04034b50,
  CENTRAL_FILE: 0x02014b50,
  DATA_DESCRIPTOR: 0x08074b50,
  END_OF_CENTRAL_DIRECTORY: 0x06054b50,
});
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000;
const ZIP64_EXTRA_FIELD = 0x0001;
const STRONG_ENCRYPTION_EXTRA_FIELD = 0x0017;
const AES_EXTRA_FIELD = 0x9901;
const AES_COMPRESSION_METHOD = 99;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const CP437_EXTENDED = Array.from(
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ",
);
const UTF8_FILENAME_DECODER =
  typeof TextDecoder === "function" ? new TextDecoder("utf-8", { fatal: true }) : null;

export const ZIP_IMPORT_ERROR_CODES = Object.freeze({
  INVALID_FILE: "INVALID_ZIP_FILE",
  LIBRARY_UNAVAILABLE: "ZIP_LIBRARY_UNAVAILABLE",
  UNSAFE_PATH: "UNSAFE_ZIP_PATH",
  ENCRYPTED: "ENCRYPTED_ZIP_NOT_SUPPORTED",
  UNSUPPORTED_COMPRESSION: "UNSUPPORTED_ZIP_COMPRESSION",
  LIMIT_EXCEEDED: "ZIP_LIMIT_EXCEEDED",
  DUPLICATE_PATH: "DUPLICATE_ZIP_IMAGE_PATH",
  NO_IMAGES: "ZIP_HAS_NO_IMAGES",
});

export class ZipImportError extends Error {
  constructor({ code, message, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ZipImportError";
    this.code = code;
  }
}

function fail({ code, message, cause }) {
  throw new ZipImportError({ code, message, cause });
}

function invalidZip(message = "ZIP structure is invalid.", cause) {
  fail({ code: ZIP_IMPORT_ERROR_CODES.INVALID_FILE, message, cause });
}

function getExtension(path) {
  const name = path.split("/").at(-1) || "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function isSupportedImagePath(path) {
  return Boolean(IMAGE_MIME_TYPES[getExtension(path)]);
}

function validateArchivePath(value) {
  try {
    return normalizeAnnotationRelativePath(value);
  } catch (error) {
    fail({
      code: ZIP_IMPORT_ERROR_CODES.UNSAFE_PATH,
      message: "ZIP contains an unsafe entry path.",
      cause: error,
    });
  }
}

function getZipLibrary(zipLibrary) {
  const library = zipLibrary || globalThis.fflate;
  if (
    typeof library?.AsyncInflate !== "function" ||
    typeof library?.strFromU8 !== "function"
  ) {
    fail({
      code: ZIP_IMPORT_ERROR_CODES.LIBRARY_UNAVAILABLE,
      message: "ZIP support could not be loaded. Reload the page and try again.",
    });
  }
  return library;
}

function assertByteRange(bytes, offset, length) {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.byteLength
  ) {
    invalidZip();
  }
}

function readUint16(view, bytes, offset) {
  assertByteRange(bytes, offset, 2);
  return view.getUint16(offset, true);
}

function readUint32(view, bytes, offset) {
  assertByteRange(bytes, offset, 4);
  return view.getUint32(offset, true);
}

function findEndOfCentralDirectory({ bytes, view }) {
  if (bytes.byteLength < ZIP_EOCD_MIN_BYTES) {
    invalidZip();
  }
  const lowerBound = Math.max(
    0,
    bytes.byteLength - ZIP_EOCD_MIN_BYTES - ZIP_MAX_COMMENT_BYTES,
  );
  for (let offset = bytes.byteLength - ZIP_EOCD_MIN_BYTES; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_SIGNATURES.END_OF_CENTRAL_DIRECTORY) {
      continue;
    }
    const commentLength = readUint16(view, bytes, offset + 20);
    if (offset + ZIP_EOCD_MIN_BYTES + commentLength === bytes.byteLength) {
      return offset;
    }
  }
  invalidZip("ZIP central directory could not be found.");
}

function inspectExtraFields({ view, bytes, offset, length }) {
  assertByteRange(bytes, offset, length);
  const end = offset + length;
  let cursor = offset;
  let hasZip64 = false;
  let hasStrongEncryption = false;
  let hasAes = false;
  while (cursor < end) {
    if (cursor + 4 > end) {
      invalidZip("ZIP extra-field data is invalid.");
    }
    const headerId = readUint16(view, bytes, cursor);
    const fieldLength = readUint16(view, bytes, cursor + 2);
    cursor += 4;
    if (cursor + fieldLength > end) {
      invalidZip("ZIP extra-field data is invalid.");
    }
    hasZip64 ||= headerId === ZIP64_EXTRA_FIELD;
    hasStrongEncryption ||= headerId === STRONG_ENCRYPTION_EXTRA_FIELD;
    hasAes ||= headerId === AES_EXTRA_FIELD;
    cursor += fieldLength;
  }
  return { hasZip64, hasStrongEncryption, hasAes };
}

function decodeEntryName({ library, bytes, flags }) {
  try {
    if (flags & ZIP_UTF8_FLAG) {
      return UTF8_FILENAME_DECODER
        ? UTF8_FILENAME_DECODER.decode(bytes)
        : library.strFromU8(bytes, false);
    }
    let decoded = "";
    for (const byte of bytes) {
      decoded += byte < 0x80 ? String.fromCharCode(byte) : CP437_EXTENDED[byte - 0x80];
    }
    return decoded;
  } catch (error) {
    invalidZip("ZIP contains an invalid entry name.", error);
  }
}

function assertNotEncrypted({ flags, method, hasAes, hasStrongEncryption }) {
  if (
    (flags & ZIP_ENCRYPTION_FLAGS) !== 0 ||
    method === AES_COMPRESSION_METHOD ||
    hasAes ||
    hasStrongEncryption
  ) {
    fail({
      code: ZIP_IMPORT_ERROR_CODES.ENCRYPTED,
      message: "Encrypted ZIP files are not supported. Extract the archive and open its folder instead.",
    });
  }
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function readDataDescriptor({ entry, bytes, view }) {
  const descriptorOffset = entry.dataEnd;
  const matchesAt = (offset) => {
    if (offset + 12 > bytes.byteLength) {
      return false;
    }
    return (
      view.getUint32(offset, true) === entry.crc32 &&
      view.getUint32(offset + 4, true) === entry.compressedSize &&
      view.getUint32(offset + 8, true) === entry.originalSize
    );
  };
  if (
    descriptorOffset + 16 <= bytes.byteLength &&
    view.getUint32(descriptorOffset, true) === ZIP_SIGNATURES.DATA_DESCRIPTOR &&
    matchesAt(descriptorOffset + 4)
  ) {
    return descriptorOffset + 16;
  }
  if (matchesAt(descriptorOffset)) {
    return descriptorOffset + 12;
  }
  invalidZip(`ZIP data descriptor is inconsistent for ${entry.path}.`);
}

function validateDeclaredImageLimits({ entry, limits }) {
  if (entry.method !== 0 && entry.method !== 8) {
    fail({
      code: ZIP_IMPORT_ERROR_CODES.UNSUPPORTED_COMPRESSION,
      message: `${entry.path} uses unsupported ZIP compression method ${entry.method}.`,
    });
  }
  if (entry.method === 0 && entry.compressedSize !== entry.originalSize) {
    invalidZip(`${entry.path} has inconsistent stored-entry sizes.`);
  }
  if (entry.originalSize > MAX_ZIP_ENTRY_BYTES) {
    fail({
      code: ZIP_IMPORT_ERROR_CODES.LIMIT_EXCEEDED,
      message: `${entry.path} expands beyond the ${Math.round(MAX_ZIP_ENTRY_BYTES / 1024 / 1024)} MB per-image limit.`,
    });
  }
  const compressionRatio = entry.originalSize / Math.max(1, entry.compressedSize);
  if (compressionRatio > MAX_ZIP_COMPRESSION_RATIO) {
    fail({
      code: ZIP_IMPORT_ERROR_CODES.LIMIT_EXCEEDED,
      message: `${entry.path} has an unsafe ZIP compression ratio.`,
    });
  }
  limits.expandedBytes += entry.originalSize;
  if (limits.expandedBytes > MAX_ZIP_EXPANDED_BYTES) {
    fail({
      code: ZIP_IMPORT_ERROR_CODES.LIMIT_EXCEEDED,
      message: `ZIP expands beyond the ${Math.round(MAX_ZIP_EXPANDED_BYTES / 1024 / 1024)} MB limit.`,
    });
  }
}

function validateLocalHeader({ entry, bytes, view, library, centralOffset }) {
  const offset = entry.localHeaderOffset;
  if (readUint32(view, bytes, offset) !== ZIP_SIGNATURES.LOCAL_FILE) {
    invalidZip("ZIP local-file header is missing.");
  }
  const flags = readUint16(view, bytes, offset + 6);
  const method = readUint16(view, bytes, offset + 8);
  const crc32 = readUint32(view, bytes, offset + 14);
  const compressedSize = readUint32(view, bytes, offset + 18);
  const originalSize = readUint32(view, bytes, offset + 22);
  const nameLength = readUint16(view, bytes, offset + 26);
  const extraLength = readUint16(view, bytes, offset + 28);
  const nameOffset = offset + 30;
  const extraOffset = nameOffset + nameLength;
  const dataStart = extraOffset + extraLength;
  assertByteRange(bytes, nameOffset, nameLength);
  assertByteRange(bytes, extraOffset, extraLength);
  const extra = inspectExtraFields({ view, bytes, offset: extraOffset, length: extraLength });
  if (extra.hasZip64 || compressedSize === 0xffffffff || originalSize === 0xffffffff) {
    invalidZip("ZIP64 entries are not supported for this import size.");
  }
  assertNotEncrypted({
    flags,
    method,
    hasAes: extra.hasAes,
    hasStrongEncryption: extra.hasStrongEncryption,
  });
  const localNameBytes = bytes.subarray(nameOffset, nameOffset + nameLength);
  const localPath = validateArchivePath(
    decodeEntryName({
      library,
      bytes: localNameBytes,
      flags,
    }),
  );
  if (
    localPath !== entry.path ||
    !bytesEqual(localNameBytes, entry.nameBytes) ||
    flags !== entry.flags ||
    method !== entry.method
  ) {
    invalidZip(`ZIP headers disagree for ${entry.path}.`);
  }
  const usesDescriptor = Boolean(flags & ZIP_DATA_DESCRIPTOR_FLAG);
  if (
    (!usesDescriptor &&
      (crc32 !== entry.crc32 ||
        compressedSize !== entry.compressedSize ||
        originalSize !== entry.originalSize)) ||
    (usesDescriptor &&
      ((crc32 !== 0 && crc32 !== entry.crc32) ||
        (compressedSize !== 0 && compressedSize !== entry.compressedSize) ||
        (originalSize !== 0 && originalSize !== entry.originalSize)))
  ) {
    invalidZip(`ZIP headers contain inconsistent sizes for ${entry.path}.`);
  }
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > centralOffset) {
    invalidZip(`ZIP entry data is out of bounds for ${entry.path}.`);
  }
  const withDataRange = { ...entry, dataStart, dataEnd };
  const rangeEnd = usesDescriptor
    ? readDataDescriptor({ entry: withDataRange, bytes, view })
    : dataEnd;
  if (rangeEnd > centralOffset) {
    invalidZip(`ZIP entry descriptor is out of bounds for ${entry.path}.`);
  }
  return { ...withDataRange, rangeEnd };
}

function assertNonOverlappingEntryRanges(entries) {
  const ranges = entries
    .map((entry) => ({ start: entry.localHeaderOffset, end: entry.rangeEnd }))
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      invalidZip("ZIP entries use overlapping local data ranges.");
    }
  }
}

function parseZipDirectory(bytes, library) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory({ bytes, view });
  const diskNumber = readUint16(view, bytes, eocdOffset + 4);
  const centralDisk = readUint16(view, bytes, eocdOffset + 6);
  const entriesOnDisk = readUint16(view, bytes, eocdOffset + 8);
  const entryCount = readUint16(view, bytes, eocdOffset + 10);
  const centralSize = readUint32(view, bytes, eocdOffset + 12);
  const centralOffset = readUint32(view, bytes, eocdOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    invalidZip("Multi-disk and ZIP64 archives are not supported for this import size.");
  }
  if (entryCount > MAX_IMAGE_SET_ENTRIES) {
    fail({
      code: ZIP_IMPORT_ERROR_CODES.LIMIT_EXCEEDED,
      message: `ZIP contains more than ${MAX_IMAGE_SET_ENTRIES} entries.`,
    });
  }
  if (centralOffset + centralSize !== eocdOffset) {
    invalidZip("ZIP central-directory bounds are invalid.");
  }

  const limits = { expandedBytes: 0 };
  const seenPaths = new Set();
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(view, bytes, cursor) !== ZIP_SIGNATURES.CENTRAL_FILE) {
      invalidZip("ZIP central-file header is invalid.");
    }
    const flags = readUint16(view, bytes, cursor + 8);
    const method = readUint16(view, bytes, cursor + 10);
    const crc32 = readUint32(view, bytes, cursor + 16);
    const compressedSize = readUint32(view, bytes, cursor + 20);
    const originalSize = readUint32(view, bytes, cursor + 24);
    const nameLength = readUint16(view, bytes, cursor + 28);
    const extraLength = readUint16(view, bytes, cursor + 30);
    const commentLength = readUint16(view, bytes, cursor + 32);
    const diskStart = readUint16(view, bytes, cursor + 34);
    const localHeaderOffset = readUint32(view, bytes, cursor + 42);
    const nameOffset = cursor + 46;
    const extraOffset = nameOffset + nameLength;
    const nextCursor = extraOffset + extraLength + commentLength;
    assertByteRange(bytes, nameOffset, nameLength);
    assertByteRange(bytes, extraOffset, extraLength + commentLength);
    const extra = inspectExtraFields({ view, bytes, offset: extraOffset, length: extraLength });
    if (
      diskStart !== 0 ||
      extra.hasZip64 ||
      compressedSize === 0xffffffff ||
      originalSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      invalidZip("Multi-disk and ZIP64 entries are not supported for this import size.");
    }
    assertNotEncrypted({
      flags,
      method,
      hasAes: extra.hasAes,
      hasStrongEncryption: extra.hasStrongEncryption,
    });
    const nameBytes = bytes.slice(nameOffset, nameOffset + nameLength);
    const decodedName = decodeEntryName({ library, bytes: nameBytes, flags });
    const path = validateArchivePath(decodedName);
    const pathKey = path.toLowerCase();
    if (seenPaths.has(pathKey)) {
      fail({
        code: ZIP_IMPORT_ERROR_CODES.DUPLICATE_PATH,
        message: `ZIP contains duplicate entry path ${path}.`,
      });
    }
    seenPaths.add(pathKey);
    const entry = {
      path,
      flags,
      method,
      crc32,
      compressedSize,
      originalSize,
      localHeaderOffset,
      nameBytes,
      isImage: !decodedName.endsWith("/") && isSupportedImagePath(path),
    };
    if (entry.isImage) {
      validateDeclaredImageLimits({ entry, limits });
    }
    entries.push(entry);
    cursor = nextCursor;
  }
  if (cursor !== centralOffset + centralSize) {
    invalidZip("ZIP central-directory length is inconsistent.");
  }
  const validatedEntries = entries.map((entry) =>
    validateLocalHeader({ entry, bytes, view, library, centralOffset }),
  );
  assertNonOverlappingEntryRanges(validatedEntries);
  const imageEntries = validatedEntries.filter((entry) => entry.isImage);
  if (!imageEntries.length) {
    fail({
      code: ZIP_IMPORT_ERROR_CODES.NO_IMAGES,
      message: "ZIP does not contain any supported images.",
    });
  }
  return imageEntries;
}

function preflightZip(bytes, library) {
  try {
    return parseZipDirectory(bytes, library);
  } catch (error) {
    if (error instanceof ZipImportError) {
      throw error;
    }
    invalidZip("ZIP could not be read. It may be corrupt or unsupported.", error);
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(crc, bytes) {
  let value = crc;
  for (let index = 0; index < bytes.length; index += 1) {
    value = CRC32_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

function assertExtractedEntry({ entry, actualBytes, crc }) {
  if (actualBytes > MAX_ZIP_ENTRY_BYTES) {
    fail({
      code: ZIP_IMPORT_ERROR_CODES.LIMIT_EXCEEDED,
      message: `${entry.path} exceeds the per-image extraction limit.`,
    });
  }
  if (actualBytes !== entry.originalSize) {
    invalidZip(`${entry.path} does not match its declared expanded size.`);
  }
  if (actualBytes / Math.max(1, entry.compressedSize) > MAX_ZIP_COMPRESSION_RATIO) {
    fail({
      code: ZIP_IMPORT_ERROR_CODES.LIMIT_EXCEEDED,
      message: `${entry.path} exceeds the ZIP compression-ratio limit.`,
    });
  }
  if (((crc ^ 0xffffffff) >>> 0) !== entry.crc32) {
    invalidZip(`${entry.path} failed its ZIP checksum.`);
  }
}

function extractStoredEntry({ entry, bytes }) {
  const chunk = bytes.slice(entry.dataStart, entry.dataEnd);
  const crc = updateCrc32(0xffffffff, chunk);
  assertExtractedEntry({ entry, actualBytes: chunk.byteLength, crc });
  return Promise.resolve({ entry, parts: [chunk], actualBytes: chunk.byteLength });
}

function asExtractionError(entry, error) {
  if (error instanceof ZipImportError) {
    return error;
  }
  return new ZipImportError({
    code: ZIP_IMPORT_ERROR_CODES.INVALID_FILE,
    message: `${entry.path} could not be decompressed.`,
    cause: error,
  });
}

function extractDeflatedEntry({ entry, bytes, library, activeCancels }) {
  let cancel = null;
  const extraction = new Promise((resolve, reject) => {
    let inflater;
    let settled = false;
    let offset = entry.dataStart;
    let actualBytes = 0;
    let crc = 0xffffffff;
    const parts = [];

    const rejectAndTerminate = (rawError) => {
      if (settled) {
        return;
      }
      settled = true;
      let error = asExtractionError(entry, rawError);
      if (typeof inflater?.terminate === "function") {
        try {
          inflater.terminate();
        } catch (terminationError) {
          error = new ZipImportError({
            code: error.code || ZIP_IMPORT_ERROR_CODES.INVALID_FILE,
            message: error.message,
            cause: new AggregateError(
              [error, terminationError],
              `${entry.path} failed and its ZIP worker could not be terminated.`,
            ),
          });
        }
      }
      reject(error);
    };

    const pushNextChunk = () => {
      if (settled) {
        return;
      }
      const end = Math.min(entry.dataEnd, offset + ZIP_INFLATE_INPUT_CHUNK_BYTES);
      const final = end === entry.dataEnd;
      const chunk = bytes.slice(offset, end);
      offset = end;
      try {
        inflater.push(chunk, final);
      } catch (error) {
        rejectAndTerminate(error);
      }
    };

    try {
      inflater = new library.AsyncInflate((error, chunk, final) => {
        if (settled) {
          return;
        }
        if (error) {
          rejectAndTerminate(error);
          return;
        }
        if (chunk?.byteLength) {
          actualBytes += chunk.byteLength;
          if (actualBytes > MAX_ZIP_ENTRY_BYTES) {
            rejectAndTerminate(
              new ZipImportError({
                code: ZIP_IMPORT_ERROR_CODES.LIMIT_EXCEEDED,
                message: `${entry.path} exceeds the per-image extraction limit.`,
              }),
            );
            return;
          }
          if (actualBytes > entry.originalSize) {
            rejectAndTerminate(
              new ZipImportError({
                code: ZIP_IMPORT_ERROR_CODES.INVALID_FILE,
                message: `${entry.path} expands beyond its declared size.`,
              }),
            );
            return;
          }
          crc = updateCrc32(crc, chunk);
          parts.push(chunk);
        }
        if (final) {
          try {
            assertExtractedEntry({ entry, actualBytes, crc });
          } catch (validationError) {
            rejectAndTerminate(validationError);
            return;
          }
          settled = true;
          resolve({ entry, parts, actualBytes });
          return;
        }
        pushNextChunk();
      });
      cancel = (error) => rejectAndTerminate(error);
      activeCancels.add(cancel);
      pushNextChunk();
    } catch (error) {
      rejectAndTerminate(error);
    }
  });
  return extraction.finally(() => {
    if (cancel) {
      activeCancels.delete(cancel);
    }
  });
}

function extractEntry(options) {
  return options.entry.method === 0
    ? extractStoredEntry(options)
    : extractDeflatedEntry(options);
}

async function extractImageEntries({ entries, bytes, library }) {
  const results = new Array(entries.length);
  const activeCancels = new Set();
  let nextIndex = 0;
  let firstFailure = null;

  const cancelActive = (error) => {
    for (const cancel of [...activeCancels]) {
      cancel(error);
    }
  };
  const runWorker = async () => {
    while (!firstFailure) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= entries.length) {
        return;
      }
      try {
        results[index] = await extractEntry({
          entry: entries[index],
          bytes,
          library,
          activeCancels,
        });
      } catch (error) {
        firstFailure = firstFailure || error;
        cancelActive(firstFailure);
        throw firstFailure;
      }
    }
  };

  const workerCount = Math.min(MAX_ZIP_INFLATE_CONCURRENCY, entries.length);
  try {
    await Promise.all(Array.from({ length: workerCount }, runWorker));
  } catch (error) {
    cancelActive(error);
    throw error;
  }
  const actualExpandedBytes = results.reduce(
    (total, result) => total + result.actualBytes,
    0,
  );
  if (actualExpandedBytes > MAX_ZIP_EXPANDED_BYTES) {
    fail({
      code: ZIP_IMPORT_ERROR_CODES.LIMIT_EXCEEDED,
      message: "ZIP exceeds the total extraction limit.",
    });
  }
  return results;
}

function makeImageFile(parts, path, archiveFile) {
  const name = path.split("/").at(-1) || path;
  const type = IMAGE_MIME_TYPES[getExtension(path)];
  return new File(parts, name, {
    type,
    lastModified: Number(archiveFile.lastModified) || Date.now(),
  });
}

function naturalCompare(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

export async function readImageSourcesFromZip(file, options = {}) {
  if (!file || typeof file.arrayBuffer !== "function") {
    fail({ code: ZIP_IMPORT_ERROR_CODES.INVALID_FILE, message: "Choose a ZIP file." });
  }
  if (file.size > MAX_ZIP_FILE_BYTES) {
    fail({
      code: ZIP_IMPORT_ERROR_CODES.LIMIT_EXCEEDED,
      message: `ZIP is larger than ${Math.round(MAX_ZIP_FILE_BYTES / 1024 / 1024)} MB. Open its folder instead.`,
    });
  }
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    fail({
      code: ZIP_IMPORT_ERROR_CODES.INVALID_FILE,
      message: "ZIP file could not be read.",
      cause: error,
    });
  }
  const library = getZipLibrary(options.zipLibrary);
  const imageEntries = preflightZip(bytes, library);
  const extractedEntries = await extractImageEntries({ entries: imageEntries, bytes, library });
  const paths = stripSharedRootDirectory(
    extractedEntries.map(({ entry }) => entry.path),
  );
  const seen = new Set();
  const sources = extractedEntries.map((result, index) => {
    const path = paths[index];
    const key = path.toLowerCase();
    if (seen.has(key)) {
      fail({
        code: ZIP_IMPORT_ERROR_CODES.DUPLICATE_PATH,
        message: `ZIP contains duplicate image path ${path}.`,
      });
    }
    seen.add(key);
    return {
      file: makeImageFile(result.parts, path, file),
      path,
    };
  });
  return sources.sort((left, right) => naturalCompare(left.path, right.path));
}
