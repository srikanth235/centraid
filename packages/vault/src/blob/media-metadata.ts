// Bounded, parse-only media metadata (issue #414 D13).
//
// The gateway never decodes/transcodes media. These small container walks
// read duration, display dimensions, codec and creation time from ISO-BMFF
// (MP4/MOV) and WebM/EBML, plus owner-facing title/artist from ID3 and
// Vorbis comments. Every cursor is bounds-checked and both recursion and
// element counts are capped: malformed bytes degrade to partial/no metadata.

export interface MediaMetadata {
  duration_s?: number;
  width?: number;
  height?: number;
  codec?: string;
  captured_at?: string;
  title?: string;
  artist?: string;
}

const MAX_DEPTH = 8;
const MAX_ELEMENTS = 20_000;
const MP4_EPOCH_OFFSET_S = 2_082_844_800;

interface IsoBox {
  type: string;
  payload: number;
  end: number;
}

function isoBoxes(bytes: Buffer, start: number, end: number): IsoBox[] {
  const boxes: IsoBox[] = [];
  let at = start;
  while (at + 8 <= end && boxes.length < MAX_ELEMENTS) {
    let size = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      const wide = bytes.readBigUInt64BE(at + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(wide);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    boxes.push({ type, payload: at + header, end: at + size });
    at += size;
  }
  return boxes;
}

function isoTime(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= MP4_EPOCH_OFFSET_S) return undefined;
  const ms = (seconds - MP4_EPOCH_OFFSET_S) * 1000;
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  return year >= 1970 && year <= 3000 ? date.toISOString() : undefined;
}

function safeRatio(numerator: number | bigint, denominator: number): number | undefined {
  const n = typeof numerator === 'bigint' ? Number(numerator) : numerator;
  const value = denominator > 0 ? n / denominator : NaN;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

const ISO_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta']);
const KNOWN_CODECS = new Set([
  'avc1',
  'avc3',
  'hvc1',
  'hev1',
  'vp08',
  'vp09',
  'av01',
  'mp4v',
  'mp4a',
  'ac-3',
  'ec-3',
  'alac',
  'Opus',
]);

/** Parse ISO-BMFF box metadata without reading sample payloads. */
export function parseIsoBmffMetadata(bytes: Buffer): MediaMetadata {
  const out: MediaMetadata = {};
  let visited = 0;
  const walk = (start: number, end: number, depth: number): void => {
    if (depth > MAX_DEPTH || visited >= MAX_ELEMENTS) return;
    for (const box of isoBoxes(bytes, start, end)) {
      if ((visited += 1) > MAX_ELEMENTS) return;
      try {
        if (box.type === 'mvhd' && box.payload + 20 <= box.end) {
          const version = bytes[box.payload];
          if (version === 1 && box.payload + 32 <= box.end) {
            const creation = bytes.readBigUInt64BE(box.payload + 4);
            const timescale = bytes.readUInt32BE(box.payload + 20);
            const duration = bytes.readBigUInt64BE(box.payload + 24);
            if (creation <= BigInt(Number.MAX_SAFE_INTEGER)) {
              out.captured_at ??= isoTime(Number(creation));
            }
            out.duration_s ??= safeRatio(duration, timescale);
          } else if (version === 0) {
            out.captured_at ??= isoTime(bytes.readUInt32BE(box.payload + 4));
            out.duration_s ??= safeRatio(
              bytes.readUInt32BE(box.payload + 16),
              bytes.readUInt32BE(box.payload + 12),
            );
          }
        } else if (box.type === 'tkhd' && box.end - box.payload >= 12) {
          const width = bytes.readUInt32BE(box.end - 8) / 65_536;
          const height = bytes.readUInt32BE(box.end - 4) / 65_536;
          if (width >= 1 && height >= 1 && width <= 32_768 && height <= 32_768) {
            out.width ??= Math.round(width);
            out.height ??= Math.round(height);
          }
        } else if (box.type === 'stsd' && box.payload + 16 <= box.end) {
          const entries = bytes.readUInt32BE(box.payload + 4);
          let entry = box.payload + 8;
          for (let i = 0; i < Math.min(entries, 64) && entry + 8 <= box.end; i += 1) {
            const size = bytes.readUInt32BE(entry);
            const codec = bytes.toString('latin1', entry + 4, entry + 8);
            if (KNOWN_CODECS.has(codec)) out.codec ??= codec.trim();
            if (size < 8 || entry + size > box.end) break;
            entry += size;
          }
        }
      } catch {
        // One malformed box does not discard metadata parsed from siblings.
      }
      if (ISO_CONTAINERS.has(box.type)) walk(box.payload, box.end, depth + 1);
      // `meta` is a FullBox: four version/flags bytes precede its children.
      if (box.type === 'meta' && box.payload + 4 <= box.end) {
        walk(box.payload + 4, box.end, depth + 1);
      }
    }
  };
  walk(0, bytes.length, 0);
  return out;
}

interface EbmlVint {
  value: number;
  width: number;
  unknown: boolean;
}

function ebmlVint(bytes: Buffer, at: number, keepMarker: boolean): EbmlVint | null {
  if (at >= bytes.length) return null;
  const first = bytes[at]!;
  let width = 1;
  let mask = 0x80;
  while (width <= 8 && (first & mask) === 0) {
    width += 1;
    mask >>= 1;
  }
  if (width > 8 || at + width > bytes.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = !keepMarker && (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < width; i += 1) {
    const byte = bytes[at + i]!;
    value = value * 256 + byte;
    allOnes = allOnes && byte === 0xff;
    if (!Number.isSafeInteger(value)) return null;
  }
  return { value, width, unknown: allOnes };
}

function unsignedBe(bytes: Buffer, start: number, end: number): number | undefined {
  if (end <= start || end - start > 8) return undefined;
  let value = 0;
  for (let i = start; i < end; i += 1) {
    value = value * 256 + bytes[i]!;
    if (!Number.isSafeInteger(value)) return undefined;
  }
  return value;
}

function signedBe(bytes: Buffer, start: number, end: number): bigint | undefined {
  if (end <= start || end - start > 8) return undefined;
  let value = 0n;
  for (let i = start; i < end; i += 1) value = (value << 8n) | BigInt(bytes[i]!);
  const bits = BigInt((end - start) * 8);
  if ((bytes[start]! & 0x80) !== 0) value -= 1n << bits;
  return value;
}

const EBML_MASTER = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0xe1]);

interface EbmlTrack {
  type?: number;
  codec?: string;
  width?: number;
  height?: number;
}

/** Parse bounded WebM/Matroska Info + Tracks elements. */
export function parseWebmMetadata(bytes: Buffer): MediaMetadata {
  const out: MediaMetadata = {};
  const tracks: EbmlTrack[] = [];
  let timecodeScale = 1_000_000;
  let durationUnits: number | undefined;
  let visited = 0;

  const walk = (start: number, end: number, depth: number, track?: EbmlTrack): void => {
    if (depth > MAX_DEPTH || visited >= MAX_ELEMENTS) return;
    let at = start;
    while (at < end && visited < MAX_ELEMENTS) {
      const id = ebmlVint(bytes, at, true);
      if (!id) return;
      const size = ebmlVint(bytes, at + id.width, false);
      if (!size || size.unknown) return;
      const payload = at + id.width + size.width;
      const elementEnd = payload + size.value;
      if (payload > elementEnd || elementEnd > end || elementEnd > bytes.length) return;
      visited += 1;
      let childTrack = track;
      if (id.value === 0xae) {
        childTrack = {};
        tracks.push(childTrack);
      }
      try {
        if (id.value === 0x2ad7b1) {
          timecodeScale = unsignedBe(bytes, payload, elementEnd) ?? timecodeScale;
        } else if (id.value === 0x4489) {
          if (size.value === 4) durationUnits = bytes.readFloatBE(payload);
          if (size.value === 8) durationUnits = bytes.readDoubleBE(payload);
        } else if (id.value === 0x4461) {
          const nanos = signedBe(bytes, payload, elementEnd);
          if (nanos !== undefined) {
            const base = Date.UTC(2001, 0, 1);
            const millis = Number(nanos / 1_000_000n);
            const date = new Date(base + millis);
            if (!Number.isNaN(date.getTime())) out.captured_at ??= date.toISOString();
          }
        } else if (id.value === 0x83 && childTrack) {
          childTrack.type = unsignedBe(bytes, payload, elementEnd);
        } else if (id.value === 0x86 && childTrack) {
          childTrack.codec = stripTrailingNul(bytes.toString('utf8', payload, elementEnd));
        } else if (id.value === 0xb0 && childTrack) {
          childTrack.width = unsignedBe(bytes, payload, elementEnd);
        } else if (id.value === 0xba && childTrack) {
          childTrack.height = unsignedBe(bytes, payload, elementEnd);
        }
      } catch {
        // Partial metadata is still useful.
      }
      if (EBML_MASTER.has(id.value)) walk(payload, elementEnd, depth + 1, childTrack);
      at = elementEnd;
    }
  };
  walk(0, bytes.length, 0);
  if (durationUnits !== undefined) {
    const seconds = (durationUnits * timecodeScale) / 1_000_000_000;
    if (Number.isFinite(seconds) && seconds >= 0) out.duration_s = seconds;
  }
  const video = tracks.find((track) => track.type === 1);
  const chosen = video ?? tracks.find((track) => track.type === 2);
  if (video?.width && video.height) {
    out.width = video.width;
    out.height = video.height;
  }
  if (chosen?.codec) out.codec = chosen.codec;
  return out;
}

function syncSafe(bytes: Buffer, at: number): number {
  if (at + 4 > bytes.length) return 0;
  return (
    ((bytes[at]! & 0x7f) << 21) |
    ((bytes[at + 1]! & 0x7f) << 14) |
    ((bytes[at + 2]! & 0x7f) << 7) |
    (bytes[at + 3]! & 0x7f)
  );
}

function stripTrailingNul(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0) end -= 1;
  return value.slice(0, end);
}

function decodeTagText(bytes: Buffer): string {
  if (bytes.length === 0) return '';
  const encoding = bytes[0];
  const body = bytes.subarray(1);
  if (encoding === 0) return stripTrailingNul(body.toString('latin1')).trim();
  if (encoding === 3) return stripTrailingNul(body.toString('utf8')).trim();
  if (encoding === 1 && body.length >= 2) {
    if (body[0] === 0xff && body[1] === 0xfe) {
      return stripTrailingNul(body.subarray(2).toString('utf16le')).trim();
    }
    if (body[0] === 0xfe && body[1] === 0xff) {
      const swapped = Buffer.from(body.subarray(2));
      swapped.swap16();
      return stripTrailingNul(swapped.toString('utf16le')).trim();
    }
  }
  return '';
}

export function parseId3Metadata(bytes: Buffer): MediaMetadata {
  const out: MediaMetadata = { codec: 'mp3' };
  if (bytes.length < 10 || bytes.toString('latin1', 0, 3) !== 'ID3') return out;
  const version = bytes[3] ?? 0;
  const end = Math.min(bytes.length, 10 + syncSafe(bytes, 6), 16 * 1024 * 1024);
  let at = 10;
  for (let frames = 0; frames < 2048 && at + 10 <= end; frames += 1) {
    const id = bytes.toString('latin1', at, at + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = version === 4 ? syncSafe(bytes, at + 4) : bytes.readUInt32BE(at + 4);
    const payload = at + 10;
    if (size <= 0 || payload + size > end) break;
    if (id === 'TIT2') out.title = decodeTagText(bytes.subarray(payload, payload + size));
    if (id === 'TPE1') out.artist = decodeTagText(bytes.subarray(payload, payload + size));
    at = payload + size;
  }
  if (!out.title) delete out.title;
  if (!out.artist) delete out.artist;
  return out;
}

function parseVorbisComment(bytes: Buffer, start: number): Pick<MediaMetadata, 'title' | 'artist'> {
  const out: Pick<MediaMetadata, 'title' | 'artist'> = {};
  if (start + 4 > bytes.length) return out;
  const vendorBytes = bytes.readUInt32LE(start);
  let at = start + 4 + vendorBytes;
  if (at + 4 > bytes.length) return out;
  const count = Math.min(bytes.readUInt32LE(at), 4096);
  at += 4;
  for (let i = 0; i < count && at + 4 <= bytes.length; i += 1) {
    const size = bytes.readUInt32LE(at);
    at += 4;
    if (size > 1024 * 1024 || at + size > bytes.length) break;
    const comment = bytes.toString('utf8', at, at + size);
    at += size;
    const split = comment.indexOf('=');
    if (split < 1) continue;
    const key = comment.slice(0, split).toUpperCase();
    const value = comment.slice(split + 1).trim();
    if (key === 'TITLE' && value) out.title ??= value;
    if (key === 'ARTIST' && value) out.artist ??= value;
  }
  return out;
}

export function parseVorbisMetadata(bytes: Buffer): MediaMetadata {
  const out: MediaMetadata = {};
  const vorbis = bytes.indexOf(Buffer.from('\x03vorbis', 'latin1'));
  const opus = bytes.indexOf(Buffer.from('OpusTags', 'latin1'));
  if (vorbis >= 0) {
    out.codec = 'vorbis';
    Object.assign(out, parseVorbisComment(bytes, vorbis + 7));
  } else if (opus >= 0) {
    out.codec = 'opus';
    Object.assign(out, parseVorbisComment(bytes, opus + 8));
  }
  if (bytes.toString('latin1', 0, 4) === 'fLaC') {
    out.codec = 'flac';
    let at = 4;
    for (let blocks = 0; blocks < 128 && at + 4 <= bytes.length; blocks += 1) {
      const header = bytes[at]!;
      const type = header & 0x7f;
      const size = bytes.readUIntBE(at + 1, 3);
      const payload = at + 4;
      if (payload + size > bytes.length) break;
      if (type === 4) Object.assign(out, parseVorbisComment(bytes, payload));
      at = payload + size;
      if ((header & 0x80) !== 0) break;
    }
  }
  return out;
}

function parseWavMetadata(bytes: Buffer): MediaMetadata {
  const out: MediaMetadata = { codec: 'pcm' };
  let byteRate = 0;
  let dataSize = 0;
  for (let at = 12, chunks = 0; at + 8 <= bytes.length && chunks < 4096; chunks += 1) {
    const id = bytes.toString('latin1', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const payload = at + 8;
    if (payload + size > bytes.length) break;
    if (id === 'fmt ' && size >= 12) byteRate = bytes.readUInt32LE(payload + 8);
    if (id === 'data') dataSize = size;
    at = payload + size + (size % 2);
  }
  if (byteRate > 0) out.duration_s = dataSize / byteRate;
  return out;
}

/** Dispatch by sniffed media type/signature; never throws on malformed bytes. */
export function parseMediaMetadata(bytes: Buffer, mediaType: string): MediaMetadata {
  try {
    if (bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp') {
      return parseIsoBmffMetadata(bytes);
    }
    if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) {
      return parseWebmMetadata(bytes);
    }
    if (mediaType === 'audio/mpeg') return parseId3Metadata(bytes);
    if (mediaType === 'audio/ogg' || mediaType === 'audio/flac') return parseVorbisMetadata(bytes);
    if (mediaType === 'audio/wav') return parseWavMetadata(bytes);
  } catch {
    // Ingress is never refused because metadata is malformed.
  }
  return {};
}
