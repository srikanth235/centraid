// THE LOCATION, TAKEN OUT OF THE BYTES THEMSELVES (#816).
//
// A share sheet that omits a place from the UI and hands the operating system
// the original file has disclosed the place anyway: the fix is in the file's
// own EXIF, to about a metre, and every photo viewer on the receiving end
// reads it. "We did not show it" is not "we did not send it". So a share at
// any precision below `exact` (`share-place.ts`) runs the bytes through here
// first, and what leaves is a different file from the one on disk.
//
// WHY A SEGMENT WALK AND NOT A RE-ENCODE. Handing the frame to
// `expo-image-manipulator` and saving it again does drop the metadata, but it
// also re-compresses the photograph, throws away the capture time, and throws
// away the ORIENTATION tag — which is how a phone records "this frame is
// sideways". A shared photograph that arrives rotated because we scrubbed it
// is a bug the member will blame on the share, and rightly. This walker
// touches only the location: the compressed image data is copied through byte
// for byte, and the frames that arrive are the frames that were taken.
//
// WHAT IT REMOVES, and why each one is location:
//
//   1. The GPS IFD inside every Exif APP1 segment — latitude, longitude,
//      altitude, the fix's own timestamp. Removed by zeroing the IFD block
//      and every value it points at, which leaves an Exif block whose GPS
//      directory has zero entries. Zeroing rather than excising because every
//      offset inside a TIFF block is absolute from the block's start: cutting
//      bytes out of the middle would move every other tag's data out from
//      under its pointer, and the orientation this walker exists to preserve
//      would be the first casualty.
//   2. XMP APP1 segments. Adobe's XMP packet carries `exif:GPSLatitude` and
//      friends as text, so a member who scrubbed the binary GPS and left the
//      XMP would have shipped the coordinate in ASCII.
//   3. Photoshop APP13 segments. The IPTC record inside carries Sub-location,
//      City, Province/State and Country — a place, written in words by an
//      editor, which is exactly the thing a member chose not to send.
//
// WHAT IT DOES NOT REACH. Maker-note blobs are vendor-private and a few
// cameras have been known to duplicate a fix inside one; a container that is
// not a JPEG (HEIC, PNG, MP4) is not walkable here at all. Both are the
// caller's problem, and `photo-share.ts` deals with them by re-encoding or by
// refusing outright — never by sending the original quietly.
//
// PURE ON PURPOSE. Bytes in, bytes out, no imports, no file system: that is
// what lets the test build a photograph carrying a known fix and prove the
// digits are gone from the output, rather than asserting that some function
// was called.

/** What a strip found and took out. */
export type RemovedLocation = "exif-gps" | "xmp" | "iptc";

export interface LocationStrip {
  /** The photograph, minus every location trace listed in `removed`. */
  bytes: Uint8Array;
  /** Empty when the file carried no location at all — which is a result, not
   *  a failure: those bytes were already safe to send. */
  removed: readonly RemovedLocation[];
}

const MARKER = 0xff;
const SOI = 0xd8;
const SOS = 0xda;
const TEM = 0x01;
/** The restart markers, plus SOI and EOI: the run that carries no length word
 *  of its own, and so cannot be stepped over by one. */
const LENGTHLESS_FIRST = 0xd0;
const LENGTHLESS_LAST = 0xd9;
const APP1 = 0xe1;
const APP13 = 0xed;

/** The six bytes that open an Exif APP1 payload: `Exif` and two NULs. */
const EXIF_TAG = "Exif\u0000\u0000";
/** The XMP packet's namespace URI, terminated, as it opens its APP1. */
const XMP_TAG = "http://ns.adobe.com/xap/1.0/\u0000";
/** The Photoshop image-resource block that wraps an IPTC record. */
const PHOTOSHOP_TAG = "Photoshop 3.0\u0000";

/** The IFD0 tag holding the offset of the GPS directory. */
const GPS_IFD_TAG = 0x8825;

/** Bytes per TIFF value type, indexed by the type code stored in an entry. */
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

/**
 * How many IFDs deep the walk will follow the chain before giving up.
 *
 * A real file has two (the image and its thumbnail). A file with a cyclic
 * `next` pointer has infinitely many, and this walker must not be the thing
 * that hangs a share.
 */
const MAX_IFD_HOPS = 8;

/** Do these bytes open the way a JPEG opens? */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === MARKER && bytes[1] === SOI;
}

/** Is `text` written at `at`, byte for byte? */
function matches(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** A TIFF block's two readers, bound to its byte order and its bounds. */
interface TiffBlock {
  start: number;
  end: number;
  u16: (at: number) => number;
  u32: (at: number) => number;
}

/** The block at `start`, or null when it is not a TIFF header at all. */
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
  // 42, the answer TIFF has always used to say "you are reading me the right
  // way round". A block that fails it is not one this walker will edit.
  if (u16(start + 2) !== 42) return null;
  return { start, end, u16, u32 };
}

/**
 * Zero one IFD and everything it points at, in place.
 *
 * The block keeps its length, so every other tag's absolute offset still lands
 * where it did. What a reader finds afterwards is a directory of zero entries:
 * structurally valid, and empty of the fix that was there.
 */
function zeroIfd(bytes: Uint8Array, tiff: TiffBlock, at: number): boolean {
  if (at < tiff.start + 8 || at + 2 > tiff.end) return false;
  const count = tiff.u16(at);
  const blockEnd = at + 2 + count * 12 + 4;
  if (count === 0 || blockEnd > tiff.end) return false;
  for (let k = 0; k < count; k += 1) {
    const entry = at + 2 + k * 12;
    const size = TYPE_BYTES[tiff.u16(entry + 2)] ?? 0;
    const total = size * tiff.u32(entry + 4);
    // Four bytes or fewer live INSIDE the entry, which the block-wide fill
    // below already covers. Anything larger sits elsewhere in the block and
    // has to be found and zeroed by its own pointer, or the digits survive.
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

/** Zero the GPS directory of every IFD in one Exif block. Reports a find. */
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

/** A marker that carries no length word of its own. */
function standalone(marker: number): boolean {
  return (
    marker === TEM || (marker >= LENGTHLESS_FIRST && marker <= LENGTHLESS_LAST)
  );
}

/**
 * The same photograph with every location trace removed, or null when these
 * bytes are not a JPEG this walker understands.
 *
 * Null is the important half of the contract: a caller holding null must not
 * fall back to sending the original — see `photo-share.ts`, which re-encodes
 * or refuses.
 */
export function stripJpegLocation(bytes: Uint8Array): LocationStrip | null {
  if (!isJpeg(bytes)) return null;
  const out = bytes.slice();
  const removed = new Set<RemovedLocation>();
  // Byte ranges of `out` that survive, in order. The two-byte SOI always does.
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
    // The scan is the compressed photograph and everything after it. Nothing
    // in there is metadata, so the rest of the file is copied through whole.
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
