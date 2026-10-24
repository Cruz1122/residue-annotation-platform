import { variantKey } from './variant-presentation.js';

const TAR_BLOCK_SIZE = 512;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_END_RECORD_BYTES = 22;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_STRUCTURE_MEMBER_BYTES = 64 * 1024 * 1024;
const STRUCTURE_EXTENSIONS = new Map([
  ['.pdb', { format: 'pdb', mediaType: 'chemical/x-pdb' }],
  ['.cif', { format: 'mmcif', mediaType: 'chemical/x-cif' }],
  ['.mmcif', { format: 'mmcif', mediaType: 'chemical/x-cif' }],
]);

const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function distinctStructureOptions(options, selectedKey, otherSelectedKey) {
  return (options ?? []).filter((option) => (
    option?.value === selectedKey || option?.value !== otherSelectedKey
  ));
}

export function canCompareStructureSources(firstSource, secondSource) {
  return Boolean(
    firstSource?.key
      && secondSource?.key
      && firstSource.key !== secondSource.key,
  );
}

function decode(bytes) {
  return textDecoder.decode(bytes).replace(/\0+$/, '');
}

function isZeroBlock(bytes, offset) {
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    if (bytes[offset + index] !== 0) return false;
  }
  return true;
}

function readTextField(bytes, offset, length) {
  return decode(bytes.subarray(offset, offset + length)).trim();
}

function readOctalField(bytes, offset, length) {
  const raw = readTextField(bytes, offset, length).replace(/^\0+/, '');
  if (!raw) return 0;
  const value = Number.parseInt(raw, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function byteIndex(bytes, value, start) {
  for (let index = start; index < bytes.length; index += 1) {
    if (bytes[index] === value) return index;
  }
  return -1;
}

function parsePaxAttributes(bytes) {
  const attributes = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = byteIndex(bytes, 0x20, offset);
    if (space < 0) throw new Error('Invalid PAX header');
    const recordLength = Number.parseInt(decode(bytes.subarray(offset, space)), 10);
    if (!Number.isSafeInteger(recordLength) || recordLength < 3 || offset + recordLength > bytes.length) {
      throw new Error('Invalid PAX record length');
    }
    const recordEnd = offset + recordLength;
    const record = bytes.subarray(space + 1, recordEnd - (bytes[recordEnd - 1] === 0x0a ? 1 : 0));
    const equals = byteIndex(record, 0x3d, 0);
    if (equals > 0) {
      attributes[decode(record.subarray(0, equals))] = decode(record.subarray(equals + 1));
    }
    offset = recordEnd;
  }
  return attributes;
}

function safeArchivePath(value) {
  const path = String(value ?? '');
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/')) return null;
  if ([...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return null;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return path;
}

function headerPath(bytes, header, paxAttributes, longName) {
  if (paxAttributes.path) return paxAttributes.path;
  if (longName) return longName;
  const name = readTextField(bytes, header, 100);
  const prefix = readTextField(bytes, header + 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function structureExtension(path) {
  const lowerPath = path.toLowerCase();
  for (const [extension, metadata] of STRUCTURE_EXTENSIONS.entries()) {
    if (lowerPath.endsWith(extension)) return metadata;
  }
  return null;
}

function variantKeyInPath(path, variants) {
  for (const variant of variants) {
    const key = variantKey(variant);
    if (!key) continue;
    const matcher = new RegExp(`(?:^|[^A-Z0-9])${key}(?:$|[^A-Z0-9])`, 'i');
    if (matcher.test(path)) return key;
  }
  return '';
}

function memberType(typeFlag) {
  return typeFlag === 0 || typeFlag === 48 || typeFlag === 55;
}

function archiveBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('The variant structure archive must be an ArrayBuffer');
}

function selectVariantCandidates(candidates) {
  const selectedKeys = new Set();
  return candidates
    .sort((left, right) => left.variantKey.localeCompare(right.variantKey) || left.path.localeCompare(right.path))
    .filter((member) => {
      if (selectedKeys.has(member.variantKey)) return false;
      selectedKeys.add(member.variantKey);
      return true;
    });
}

function parseTarVariantStructureArchive(bytes, normalizedVariants) {
  const candidates = [];
  let offset = 0;
  let entries = 0;
  let globalPaxAttributes = {};
  let pendingPaxAttributes = {};
  let pendingLongName = '';

  while (offset + TAR_BLOCK_SIZE <= bytes.length) {
    if (isZeroBlock(bytes, offset)) break;
    entries += 1;
    if (entries > MAX_ARCHIVE_ENTRIES) throw new Error('Variant structure archive has too many entries');

    const headerOffset = offset;
    const size = readOctalField(bytes, headerOffset + 124, 12);
    if (size === null) throw new Error('Variant structure archive has an invalid member size');
    const dataStart = headerOffset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length || !Number.isSafeInteger(dataEnd)) {
      throw new Error('Variant structure archive member exceeds the archive');
    }

    const typeFlag = bytes[headerOffset + 156] ?? 0;
    if (typeFlag === 120) {
      pendingPaxAttributes = parsePaxAttributes(bytes.subarray(dataStart, dataEnd));
    } else if (typeFlag === 103) {
      globalPaxAttributes = { ...globalPaxAttributes, ...parsePaxAttributes(bytes.subarray(dataStart, dataEnd)) };
    } else if (typeFlag === 76) {
      pendingLongName = decode(bytes.subarray(dataStart, dataEnd)).replace(/\n+$/, '');
    } else {
      const paxAttributes = { ...globalPaxAttributes, ...pendingPaxAttributes };
      if (memberType(typeFlag)) {
        const path = safeArchivePath(headerPath(bytes, headerOffset, paxAttributes, pendingLongName));
        const extension = path ? structureExtension(path) : null;
        const variant = path ? variantKeyInPath(path, normalizedVariants) : '';
        if (path && extension && variant) {
          if (size > MAX_STRUCTURE_MEMBER_BYTES) throw new Error('Variant structure member is too large');
          candidates.push({
            variantKey: variant,
            path,
            format: extension.format,
            mediaType: extension.mediaType,
            blob: new Blob([bytes.slice(dataStart, dataEnd)], { type: extension.mediaType }),
          });
        }
      }
      pendingPaxAttributes = {};
      pendingLongName = '';
    }

    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  return selectVariantCandidates(candidates);
}

function readUint16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) return null;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return (bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)) >>> 0;
}

function isZipArchive(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && (readUint32(bytes, 0) === ZIP_LOCAL_FILE_SIGNATURE || readUint32(bytes, 0) === ZIP_END_SIGNATURE);
}

function findZipEndRecord(bytes) {
  const searchStart = Math.max(0, bytes.length - (65_535 + ZIP_END_RECORD_BYTES));
  for (let offset = bytes.length - ZIP_END_RECORD_BYTES; offset >= searchStart; offset -= 1) {
    if (readUint32(bytes, offset) === ZIP_END_SIGNATURE) return offset;
  }
  throw new Error('Variant structure ZIP has no end record');
}

function zipEntries(bytes) {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('Variant structure archive is too large');
  const endOffset = findZipEndRecord(bytes);
  const diskNumber = readUint16(bytes, endOffset + 4);
  const centralDirectoryDisk = readUint16(bytes, endOffset + 6);
  const entriesOnDisk = readUint16(bytes, endOffset + 8);
  const totalEntries = readUint16(bytes, endOffset + 10);
  const centralDirectorySize = readUint32(bytes, endOffset + 12);
  const centralDirectoryOffset = readUint32(bytes, endOffset + 16);
  const commentLength = readUint16(bytes, endOffset + 20);
  if ([diskNumber, centralDirectoryDisk, entriesOnDisk, totalEntries, centralDirectorySize, centralDirectoryOffset, commentLength].some((value) => value === null)) {
    throw new Error('Variant structure ZIP has an invalid end record');
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries || totalEntries === 0xffff) {
    throw new Error('Variant structure ZIP uses unsupported multi-disk or ZIP64 metadata');
  }
  if (endOffset + ZIP_END_RECORD_BYTES + commentLength > bytes.length
    || totalEntries > MAX_ARCHIVE_ENTRIES
    || centralDirectoryOffset + centralDirectorySize > bytes.length) {
    throw new Error('Variant structure ZIP central directory exceeds the archive');
  }

  const entries = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (readUint32(bytes, offset) !== ZIP_CENTRAL_FILE_SIGNATURE) {
      throw new Error('Variant structure ZIP has an invalid central directory entry');
    }
    const flags = readUint16(bytes, offset + 8);
    const compressionMethod = readUint16(bytes, offset + 10);
    const compressedSize = readUint32(bytes, offset + 20);
    const uncompressedSize = readUint32(bytes, offset + 24);
    const nameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const entryCommentLength = readUint16(bytes, offset + 32);
    const localHeaderOffset = readUint32(bytes, offset + 42);
    if ([flags, compressionMethod, compressedSize, uncompressedSize, nameLength, extraLength, entryCommentLength, localHeaderOffset].some((value) => value === null)) {
      throw new Error('Variant structure ZIP has an invalid entry');
    }
    const recordLength = 46 + nameLength + extraLength + entryCommentLength;
    if (offset + recordLength > bytes.length) throw new Error('Variant structure ZIP entry exceeds the archive');
    let name;
    try {
      name = decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      name = '';
    }
    entries.push({
      name,
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset += recordLength;
  }
  if (offset !== centralDirectoryOffset + centralDirectorySize) {
    throw new Error('Variant structure ZIP central directory length is inconsistent');
  }
  return entries;
}

async function readBoundedBytes(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* stream is already closed */ }
        throw new Error('Variant structure member is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function unzipMember(bytes, entry) {
  if (entry.uncompressedSize > MAX_STRUCTURE_MEMBER_BYTES) {
    throw new Error('Variant structure member is too large');
  }
  if (entry.flags & 0x1) throw new Error('Encrypted variant structure ZIP members are unsupported');
  const localOffset = entry.localHeaderOffset;
  if (readUint32(bytes, localOffset) !== ZIP_LOCAL_FILE_SIGNATURE) {
    throw new Error('Variant structure ZIP has an invalid local file header');
  }
  const nameLength = readUint16(bytes, localOffset + 26);
  const extraLength = readUint16(bytes, localOffset + 28);
  if (nameLength === null || extraLength === null) throw new Error('Variant structure ZIP has an invalid local header');
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart < 0 || dataEnd > bytes.length || !Number.isSafeInteger(dataEnd)) {
    throw new Error('Variant structure ZIP member exceeds the archive');
  }
  const compressed = bytes.subarray(dataStart, dataEnd);
  let result;
  if (entry.compressionMethod === 0) {
    result = compressed;
  } else if (entry.compressionMethod === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('ZIP decompression is not available in this browser');
    }
    const source = new Blob([compressed]).stream();
    result = await readBoundedBytes(source.pipeThrough(new DecompressionStream('deflate-raw')), MAX_STRUCTURE_MEMBER_BYTES);
  } else {
    throw new Error('Variant structure ZIP uses an unsupported compression method');
  }
  if (result.byteLength !== entry.uncompressedSize) throw new Error('Variant structure ZIP member size is invalid');
  return result;
}

async function parseZipVariantStructureArchive(bytes, normalizedVariants) {
  const candidates = [];
  let entries;
  try {
    entries = zipEntries(bytes);
  } catch (error) {
    throw error;
  }
  for (const entry of entries) {
    const path = safeArchivePath(entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name);
    const extension = path && !entry.name.endsWith('/') ? structureExtension(path) : null;
    const variant = path && extension ? variantKeyInPath(path, normalizedVariants) : '';
    if (!path || !extension || !variant) continue;
    const payload = await unzipMember(bytes, entry);
    candidates.push({
      variantKey: variant,
      path,
      format: extension.format,
      mediaType: extension.mediaType,
      blob: new Blob([payload], { type: extension.mediaType }),
    });
  }
  return selectVariantCandidates(candidates);
}

/**
 * Extract one deterministic molecular file per requested variant from the
 * ZIP published by the backend. Legacy TAR artifacts remain readable while
 * historical data is migrated, but new directory artifacts are always ZIP.
 * Paths and decompressed sizes are bounded before a member reaches Mol*.
 */
export function parseVariantStructureArchive(value, variants = []) {
  const bytes = archiveBytes(value);
  const normalizedVariants = variants.filter((variant) => variantKey(variant));
  return isZipArchive(bytes)
    ? parseZipVariantStructureArchive(bytes, normalizedVariants)
    : parseTarVariantStructureArchive(bytes, normalizedVariants);
}
