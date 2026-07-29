// Minimal ZIP reading (issue #290 phase 2) — enough for a Google Takeout
// archive: central-directory walk, stored (0) and deflated (8) entries via
// node:zlib. No zip64, no encryption, no data descriptors beyond what the
// central directory already records — Takeout archives satisfy all three.

import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;

function requireRange(
  buffer: Buffer,
  offset: number,
  length: number,
  label: string
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new Error(`truncated zip ${label}`);
  }
}

function safeEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 4_096 &&
    !name.includes("\0") &&
    !name.startsWith("/") &&
    !name.startsWith("\\") &&
    !/^[A-Za-z]:[\\/]/u.test(name) &&
    !name.split(/[\\/]/u).includes("..")
  );
}

/** Extract every file entry (directories skipped). Throws on a non-zip. */
export function readZipEntries(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22)
    throw new Error("not a zip file (no end-of-central-directory)");
  // EOCD: scan back past a possible trailing comment (max 64 KiB).
  let eocd = -1;
  const scanFloor = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= scanFloor; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory)");
  requireRange(buffer, eocd, 22, "end-of-central-directory");
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  if (disk !== 0 || centralDisk !== 0)
    throw new Error("multi-disk zip archives are not supported");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  if (entryCount > MAX_ZIP_ENTRIES)
    throw new Error(`zip contains too many entries (max ${MAX_ZIP_ENTRIES})`);
  let offset = buffer.readUInt32LE(eocd + 16);
  requireRange(buffer, offset, 0, "central directory");

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  for (let i = 0; i < entryCount; i += 1) {
    requireRange(buffer, offset, 46, "central-directory entry");
    if (buffer.readUInt32LE(offset) !== CDIR_SIG)
      throw new Error("invalid zip central-directory signature");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    requireRange(
      buffer,
      offset,
      46 + nameLength + extraLength + commentLength,
      "central-directory metadata"
    );
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue; // directory
    if (!safeEntryName(name)) throw new Error(`unsafe zip entry name: ${name}`);
    if ((flags & 1) !== 0)
      throw new Error(`encrypted zip entry is not supported: ${name}`);
    if (method !== 0 && method !== 8)
      throw new Error(`unsupported zip compression method ${method}: ${name}`);
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES)
      throw new Error(`zip entry exceeds uncompressed limit: ${name}`);
    if (
      uncompressedSize > 1024 * 1024 &&
      uncompressedSize > Math.max(1, compressedSize) * MAX_COMPRESSION_RATIO
    ) {
      throw new Error(`zip entry has unsafe compression ratio: ${name}`);
    }
    totalBytes += uncompressedSize;
    if (totalBytes > MAX_ZIP_TOTAL_BYTES)
      throw new Error("zip exceeds total uncompressed limit");

    requireRange(buffer, localOffset, 30, `local header for ${name}`);
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG)
      throw new Error(`invalid zip local-header signature: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    requireRange(buffer, dataStart, compressedSize, `entry data for ${name}`);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data =
      method === 0
        ? Buffer.from(raw)
        : inflateRawSync(raw, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
    if (data.length !== uncompressedSize)
      throw new Error(`zip entry size mismatch: ${name}`);
    entries.push({ name, data });
  }
  if (entries.length > entryCount)
    throw new Error("zip entry count is inconsistent");
  return entries;
}
