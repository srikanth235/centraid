// LOCATION TAKEN OUT OF THE BYTES (#816): omitting a place from the UI while
// handing the OS the original discloses it anyway. A walk, not a re-encode —
// re-encoding loses capture time and ORIENTATION. Maker notes and non-JPEG
// containers are out of reach; the caller re-encodes or refuses.

export type RemovedLocation = "exif-gps" | "xmp" | "iptc";

export interface LocationStrip {
  bytes: Uint8Array;
  removed: readonly RemovedLocation[];
}

const MARKER = 0xff;
const SOI = 0xd8;
const SOS = 0xda;
const TEM = 0x01;
const LENGTHLESS_FIRST = 0xd0;
const LENGTHLESS_LAST = 0xd9;
const APP1 = 0xe1;
const APP13 = 0xed;

const EXIF_TAG = "Exif\u0000\u0000";
const XMP_TAG = "http://ns.adobe.com/xap/1.0/\u0000";
const PHOTOSHOP_TAG = "Photoshop 3.0\u0000";

const GPS_IFD_TAG = 0x8825;

const TYPE_BYTES: Readonly<Record<number, number>> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
};

/** A cyclic `next` pointer must not hang a share. */
const MAX_IFD_HOPS = 8;

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === MARKER && bytes[1] === SOI;
}

function matches(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

interface TiffBlock {
  start: number;
  end: number;
  u16: (at: number) => number;
  u32: (at: number) => number;
}

function tiffBlock(
  bytes: Uint8Array,
  start: number,
  end: number
): TiffBlock | null {
  if (start + 8 > end) return null;
  const order = bytes[start];
  const big = order === 0x4d;
  if (!big && order !== 0x49) return null;
  const u16 = (at: number): number =>
    big
      ? ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)
      : ((bytes[at + 1] ?? 0) << 8) | (bytes[at] ?? 0);
  const u32 = (at: number): number => {
    const a = bytes[at] ?? 0;
    const b = bytes[at + 1] ?? 0;
    const c = bytes[at + 2] ?? 0;
    const d = bytes[at + 3] ?? 0;
    return big
      ? ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
      : ((d << 24) | (c << 16) | (b << 8) | a) >>> 0;
  };
  // 42: TIFF byte-order check.
  if (u16(start + 2) !== 42) return null;
  return { start, end, u16, u32 };
}

/** Zero in place: TIFF offsets are absolute, so excising would shift every tag. */
function zeroIfd(bytes: Uint8Array, tiff: TiffBlock, at: number): boolean {
  if (at < tiff.start + 8 || at + 2 > tiff.end) return false;
  const count = tiff.u16(at);
  const blockEnd = at + 2 + count * 12 + 4;
  if (count === 0 || blockEnd > tiff.end) return false;
  for (let k = 0; k < count; k += 1) {
    const entry = at + 2 + k * 12;
    const size = TYPE_BYTES[tiff.u16(entry + 2)] ?? 0;
    const total = size * tiff.u32(entry + 4);
    // Values over 4 bytes sit elsewhere and need their own zeroing.
    if (total > 4) {
      const valueAt = tiff.start + tiff.u32(entry + 8);
      if (valueAt >= tiff.start && valueAt + total <= tiff.end) {
        bytes.fill(0, valueAt, valueAt + total);
      }
    }
  }
  bytes.fill(0, at, blockEnd);
  return true;
}

function scrubExifGps(bytes: Uint8Array, start: number, end: number): boolean {
  const tiff = tiffBlock(bytes, start, end);
  if (tiff === null) return false;
  let removed = false;
  let offset = tiff.u32(tiff.start + 4);
  for (let hop = 0; hop < MAX_IFD_HOPS && offset >= 8; hop += 1) {
    const at = tiff.start + offset;
    if (at + 2 > tiff.end) break;
    const count = tiff.u16(at);
    if (at + 2 + count * 12 + 4 > tiff.end) break;
    for (let k = 0; k < count; k += 1) {
      const entry = at + 2 + k * 12;
      if (tiff.u16(entry) !== GPS_IFD_TAG) continue;
      if (zeroIfd(bytes, tiff, tiff.start + tiff.u32(entry + 8)))
        removed = true;
    }
    offset = tiff.u32(at + 2 + count * 12);
  }
  return removed;
}

function standalone(marker: number): boolean {
  return (
    marker === TEM || (marker >= LENGTHLESS_FIRST && marker <= LENGTHLESS_LAST)
  );
}

/** Null means not walkable — never fall back to the original. */
export function stripJpegLocation(bytes: Uint8Array): LocationStrip | null {
  if (!isJpeg(bytes)) return null;
  const out = bytes.slice();
  const removed = new Set<RemovedLocation>();
  const kept: [number, number][] = [[0, 2]];
  let i = 2;
  while (i + 1 < out.length) {
    if (out[i] !== MARKER) break;
    const marker = out[i + 1]!;
    if (standalone(marker)) {
      kept.push([i, i + 2]);
      i += 2;
      continue;
    }
    // Past SOS there is no metadata.
    if (marker === SOS) break;
    if (i + 3 >= out.length) break;
    const length = ((out[i + 2] ?? 0) << 8) | (out[i + 3] ?? 0);
    const segmentEnd = i + 2 + length;
    if (length < 2 || segmentEnd > out.length) break;
    const payload = i + 4;
    let keep = true;
    if (marker === APP1 && matches(out, payload, EXIF_TAG)) {
      if (scrubExifGps(out, payload + EXIF_TAG.length, segmentEnd)) {
        removed.add("exif-gps");
      }
    } else if (marker === APP1 && matches(out, payload, XMP_TAG)) {
      keep = false;
      removed.add("xmp");
    } else if (marker === APP13 && matches(out, payload, PHOTOSHOP_TAG)) {
      keep = false;
      removed.add("iptc");
    }
    if (keep) kept.push([i, segmentEnd]);
    i = segmentEnd;
  }
  if (i < out.length) kept.push([i, out.length]);
  const total = kept.reduce((sum, [from, to]) => sum + (to - from), 0);
  const result = new Uint8Array(total);
  let at = 0;
  for (const [from, to] of kept) {
    result.set(out.subarray(from, to), at);
    at += to - from;
  }
  return { bytes: result, removed: [...removed] };
}
