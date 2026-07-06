// Minimal ZIP reading (issue #290 phase 2) — enough for a Google Takeout
// archive: central-directory walk, stored (0) and deflated (8) entries via
// node:zlib. No zip64, no encryption, no data descriptors beyond what the
// central directory already records — Takeout archives satisfy all three.

import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Extract every file entry (directories skipped). Throws on a non-zip. */
export function readZipEntries(buffer: Buffer): ZipEntry[] {
  // EOCD: scan back past a possible trailing comment (max 64 KiB).
  let eocd = -1;
  const scanFloor = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= scanFloor; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory)');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== CDIR_SIG) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue; // directory
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.push({ name, data: Buffer.from(raw) });
    else if (method === 8) entries.push({ name, data: inflateRawSync(raw) });
    // other methods: skip silently — the caller reports unrouted entries
  }
  return entries;
}
