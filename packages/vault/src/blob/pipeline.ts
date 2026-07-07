// The spool pipeline (issue #296 §4): what the gateway learns from bytes
// while they sit in the local spool. Everything here is dependency-free and
// synchronous — declared media types are hints (content decides), image
// dimensions and EXIF capture metadata come from the bytes, and text-shaped
// formats yield an extracted-text candidate for the parent's FTS row.
// Failures degrade to "a blob with no metadata", never block ingress.
//
// GPS is a policy surface, not a parser detail: `extractBlobMeta` always
// reports whether location was present, but coordinates only ride along when
// the caller passes `keepLocation` (the `media.location` vault setting,
// issue #296 §4 — automatic extraction must not silently write location).

/** Magic-byte table: prefix (at offset) → media type. Order matters. */
const MAGIC: { offset: number; bytes: number[]; type: string }[] = [
  { offset: 0, bytes: [0xff, 0xd8, 0xff], type: 'image/jpeg' },
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], type: 'image/png' },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], type: 'image/gif' },
  { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46], type: 'application/pdf' }, // %PDF
  { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], type: 'application/zip' },
  { offset: 0, bytes: [0x1f, 0x8b], type: 'application/gzip' },
  { offset: 0, bytes: [0x49, 0x44, 0x33], type: 'audio/mpeg' }, // ID3
  { offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53], type: 'audio/ogg' },
  { offset: 0, bytes: [0x66, 0x4c, 0x61, 0x43], type: 'audio/flac' },
  { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3], type: 'video/webm' },
];

/** RIFF containers and ISO-BMFF (mp4/mov/heic) need a second probe. */
function sniffContainers(bytes: Buffer): string | null {
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF') {
    const kind = bytes.toString('latin1', 8, 12);
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'WAVE') return 'audio/wav';
    if (kind === 'AVI ') return 'video/x-msvideo';
  }
  if (bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp') {
    const brand = bytes.toString('latin1', 8, 12);
    if (brand.startsWith('hei') || brand.startsWith('mif')) return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand.startsWith('M4A')) return 'audio/mp4';
    return 'video/mp4';
  }
  return null;
}

const EXT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  json: 'application/json',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
};

/** True when the buffer decodes as UTF-8 text with no NULs in the probe. */
function looksLikeText(bytes: Buffer): boolean {
  const probe = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (probe.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real media type of a byte payload: magic bytes win, containers next,
 * the declared hint (when plausible) next, filename extension after that,
 * and a text/binary probe last. Never returns an empty string.
 */
export function sniffMediaType(bytes: Buffer, declared?: string, filename?: string): string {
  for (const m of MAGIC) {
    if (bytes.length < m.offset + m.bytes.length) continue;
    if (m.bytes.every((b, i) => bytes[m.offset + i] === b)) return m.type;
  }
  const container = sniffContainers(bytes);
  if (container) return container;
  const hint = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (hint && hint !== 'application/octet-stream') return hint;
  const ext = filename?.split('.').at(-1)?.toLowerCase() ?? '';
  if (EXT_TYPES[ext]) return EXT_TYPES[ext];
  return looksLikeText(bytes) ? 'text/plain' : 'application/octet-stream';
}

export interface BlobMeta {
  width?: number;
  height?: number;
  /** EXIF DateTimeOriginal, ISO-8601 (no zone — camera local time). */
  captured_at?: string;
  /** Whether EXIF carried GPS tags — reported even when stripped. */
  has_location?: boolean;
  latitude?: number;
  longitude?: number;
  /** Extracted document text (bounded) — becomes the `text` variant. */
  text?: string;
  [k: string]: unknown;
}

/** Extracted text is bounded — an index feed, not a second copy of the doc. */
const MAX_EXTRACT_CHARS = 200_000;

/**
 * Everything the spool learns from one payload. `keepLocation` gates GPS
 * coordinates (default: keep — it is the owner's vault; derivatives always
 * strip regardless).
 */
export function extractBlobMeta(
  bytes: Buffer,
  mediaType: string,
  options: { keepLocation?: boolean } = {},
): BlobMeta {
  const meta: BlobMeta = {};
  try {
    if (mediaType === 'image/png') Object.assign(meta, pngDimensions(bytes));
    if (mediaType === 'image/gif' && bytes.length >= 10) {
      meta.width = bytes.readUInt16LE(6);
      meta.height = bytes.readUInt16LE(8);
    }
    if (mediaType === 'image/jpeg') {
      Object.assign(meta, jpegDimensions(bytes));
      const exif = parseJpegExif(bytes);
      if (exif.captured_at) meta.captured_at = exif.captured_at;
      if (exif.latitude !== undefined && exif.longitude !== undefined) {
        meta.has_location = true;
        if (options.keepLocation !== false) {
          meta.latitude = exif.latitude;
          meta.longitude = exif.longitude;
        }
      }
    }
    if (mediaType.startsWith('text/') || mediaType === 'application/json') {
      meta.text = bytes.toString('utf8').slice(0, MAX_EXTRACT_CHARS);
    }
    if (mediaType === 'application/pdf') {
      const text = extractPdfText(bytes);
      if (text) meta.text = text.slice(0, MAX_EXTRACT_CHARS);
    }
  } catch {
    // A malformed header degrades to a metadata-less blob, never a refusal.
  }
  return meta;
}

function pngDimensions(bytes: Buffer): Pick<BlobMeta, 'width' | 'height'> {
  // IHDR is always the first chunk: length(4) "IHDR"(4) width(4) height(4).
  if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return {};
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes: Buffer): Pick<BlobMeta, 'width' | 'height'> {
  // Walk the segment chain to the first SOF marker.
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return {};
}

interface JpegExif {
  captured_at?: string;
  latitude?: number;
  longitude?: number;
}

/**
 * Minimal TIFF/EXIF walk: DateTimeOriginal (0x9003 in the Exif sub-IFD) and
 * the GPS IFD's latitude/longitude rationals. Anything unparseable returns
 * what parsed so far.
 */
function parseJpegExif(bytes: Buffer): JpegExif {
  const out: JpegExif = {};
  // Find the APP1/Exif segment.
  let i = 2;
  let tiff = -1;
  while (i + 4 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1]!;
    const size = bytes.readUInt16BE(i + 2);
    if (marker === 0xe1 && bytes.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
      tiff = i + 10;
      break;
    }
    if (marker === 0xda) break; // start of scan — no EXIF ahead
    i += 2 + size;
  }
  if (tiff < 0 || tiff + 8 > bytes.length) return out;
  const little = bytes.toString('latin1', tiff, tiff + 2) === 'II';
  const u16 = (o: number) => (little ? bytes.readUInt16LE(o) : bytes.readUInt16BE(o));
  const u32 = (o: number) => (little ? bytes.readUInt32LE(o) : bytes.readUInt32BE(o));

  interface Entry {
    tag: number;
    type: number;
    count: number;
    valueOffset: number;
  }
  const readIfd = (offset: number): Entry[] => {
    const abs = tiff + offset;
    if (abs + 2 > bytes.length) return [];
    const n = u16(abs);
    const entries: Entry[] = [];
    for (let e = 0; e < n; e += 1) {
      const at = abs + 2 + e * 12;
      if (at + 12 > bytes.length) break;
      entries.push({ tag: u16(at), type: u16(at + 2), count: u32(at + 4), valueOffset: at + 8 });
    }
    return entries;
  };
  // TIFF value widths by type: BYTE/ASCII 1, SHORT 2, LONG 4, RATIONAL 8.
  const TYPE_BYTES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };
  const valueAt = (entry: Entry): number => {
    // Values wider than 4 bytes live at a pointed-to offset.
    const size = TYPE_BYTES[entry.type] ?? 4;
    return entry.count * size <= 4 ? entry.valueOffset : tiff + u32(entry.valueOffset);
  };
  const ascii = (entry: Entry): string => {
    const at = valueAt(entry);
    // eslint-disable-next-line no-control-regex -- EXIF ASCII fields are NUL-padded to a fixed length; trim the trailing NULs (#296)
    return bytes.toString('latin1', at, at + entry.count).replace(/\0+$/, '');
  };
  const rationals = (entry: Entry): number[] => {
    const at = valueAt(entry);
    const vals: number[] = [];
    for (let r = 0; r < entry.count; r += 1) {
      const num = u32(at + r * 8);
      const den = u32(at + r * 8 + 4);
      vals.push(den === 0 ? 0 : num / den);
    }
    return vals;
  };

  const ifd0 = readIfd(u32(tiff + 4));
  const exifPtr = ifd0.find((e) => e.tag === 0x8769);
  const gpsPtr = ifd0.find((e) => e.tag === 0x8825);
  if (exifPtr) {
    const sub = readIfd(u32(exifPtr.valueOffset));
    const dto = sub.find((e) => e.tag === 0x9003) ?? ifd0.find((e) => e.tag === 0x0132);
    if (dto && dto.type === 2) {
      // "YYYY:MM:DD HH:MM:SS" → ISO-8601 local instant.
      const raw = ascii(dto);
      const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(raw);
      if (m) out.captured_at = `${m[1]}-${m[2]}-${m[3]}T${m[4]}`;
    }
  }
  if (gpsPtr) {
    const gps = readIfd(u32(gpsPtr.valueOffset));
    const latRef = gps.find((e) => e.tag === 0x0001);
    const lat = gps.find((e) => e.tag === 0x0002);
    const lonRef = gps.find((e) => e.tag === 0x0003);
    const lon = gps.find((e) => e.tag === 0x0004);
    if (lat && lon && lat.type === 5 && lon.type === 5) {
      const toDeg = (v: number[]) => (v[0] ?? 0) + (v[1] ?? 0) / 60 + (v[2] ?? 0) / 3600;
      let latitude = toDeg(rationals(lat));
      let longitude = toDeg(rationals(lon));
      if (latRef && ascii(latRef).startsWith('S')) latitude = -latitude;
      if (lonRef && ascii(lonRef).startsWith('W')) longitude = -longitude;
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        out.latitude = Math.round(latitude * 1e6) / 1e6;
        out.longitude = Math.round(longitude * 1e6) / 1e6;
      }
    }
  }
  return out;
}

/**
 * Honest, dependency-free PDF text extraction: uncompressed text-showing
 * operators only (Tj / TJ over literal strings). Compressed streams — most
 * modern PDFs — yield nothing, which degrades to title-only search. A real
 * extractor is a later pipeline plug-in; the seam (the `text` variant) is
 * what this establishes.
 */
function extractPdfText(bytes: Buffer): string | null {
  const raw = bytes.toString('latin1');
  const parts: string[] = [];
  for (const m of raw.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    parts.push(decodePdfString(m[1] ?? ''));
    if (parts.length > 5000) break;
  }
  for (const m of raw.matchAll(/\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ/g)) {
    for (const s of (m[1] ?? '').matchAll(/\(((?:\\.|[^\\)])*)\)/g)) {
      parts.push(decodePdfString(s[1] ?? ''));
    }
    if (parts.length > 5000) break;
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length >= 16 ? text : null;
}

function decodePdfString(s: string): string {
  return s
    .replace(/\\([nrtbf()\\])/g, (_, c: string) =>
      c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c === 'b' || c === 'f' ? '' : c,
    )
    .replace(/\\(\d{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}
