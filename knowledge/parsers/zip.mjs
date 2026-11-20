import { inflateRawSync } from 'node:zlib';
import { ToolError } from '../../tools/errors.mjs';

const MAX_ZIP_BYTES = 15 * 1024 * 1024;
const MAX_ENTRIES = 200;
const MAX_ENTRY_UNCOMPRESSED = 8 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 20 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;

export function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_ZIP_BYTES) {
    throw new ToolError('INVALID_DOCUMENT', 'ZIP archive is empty, malformed, or exceeds 15 MB limit.');
  }

  // Locate End of Central Directory (0x06054b50) scanning backward up to 65 KB + 22 bytes
  const minOffset = Math.max(0, buffer.length - 65557);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new ToolError('INVALID_DOCUMENT', 'Invalid Office/ZIP archive structure (missing EOCD).');
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (totalEntries > MAX_ENTRIES) {
    throw new ToolError('INVALID_DOCUMENT', `Archive contains too many entries (max ${MAX_ENTRIES}).`);
  }
  if (cdOffset + cdSize > eocdOffset) {
    throw new ToolError('INVALID_DOCUMENT', 'Corrupt ZIP central directory boundaries.');
  }

  const entries = new Map();
  let cursor = cdOffset;
  let totalUncompressed = 0;

  for (let idx = 0; idx < totalEntries; idx += 1) {
    if (cursor + 46 > eocdOffset || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new ToolError('INVALID_DOCUMENT', 'Corrupt ZIP central directory header.');
    }
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const nameEnd = cursor + 46 + fileNameLength;
    if (nameEnd + extraLength + commentLength > eocdOffset) {
      throw new ToolError('INVALID_DOCUMENT', 'ZIP entry metadata exceeds central directory.');
    }
    const rawName = buffer.toString('utf8', cursor + 46, nameEnd);
    cursor = nameEnd + extraLength + commentLength;

    const normalizedName = rawName.replaceAll('\\', '/');
    if (
      normalizedName.startsWith('/') ||
      /^[A-Za-z]:/.test(normalizedName) ||
      normalizedName.split('/').includes('..') ||
      /[\x00-\x1f]/.test(normalizedName)
    ) {
      throw new ToolError('PATH_TRAVERSAL', `Unsafe ZIP entry path "${rawName}".`);
    }

    if (normalizedName.endsWith('/')) continue; // Directory entry

    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED) {
      throw new ToolError('FILE_TOO_LARGE', `Archive entry "${normalizedName}" exceeds 8 MB uncompressed limit.`);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
      throw new ToolError('FILE_TOO_LARGE', 'Archive uncompressed total exceeds safety limit.');
    }
    if (compressedSize > 0 && uncompressedSize >= 1024 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
      throw new ToolError('INVALID_DOCUMENT', 'Suspicious ZIP compression ratio detected.');
    }

    if (localHeaderOffset + 30 > cdOffset || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new ToolError('INVALID_DOCUMENT', 'Corrupt ZIP local file header.');
    }
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cdOffset) {
      throw new ToolError('INVALID_DOCUMENT', 'ZIP entry payload extends past central directory.');
    }

    const slice = buffer.subarray(dataStart, dataEnd);
    let output;
    if (compressionMethod === 0) {
      output = Buffer.from(slice);
    } else if (compressionMethod === 8) {
      output = inflateRawSync(slice, { maxOutputLength: MAX_ENTRY_UNCOMPRESSED });
    } else {
      throw new ToolError('EXTRACTION_UNSUPPORTED', `Unsupported ZIP compression method ${compressionMethod}.`);
    }

    if (output.length > MAX_ENTRY_UNCOMPRESSED) {
      throw new ToolError('FILE_TOO_LARGE', `Decompressed entry "${normalizedName}" exceeded safety limit.`);
    }
    entries.set(normalizedName, output);
  }

  return entries;
}
