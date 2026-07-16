// Pure formatting/predicate helpers over an asset row — no DOM, no vault IO,
// no app state. Shared by app.jsx's own orchestrators (refresh/matchesSearch)
// and by every component file that needs to format or classify an asset.
import { BLOB_ROUTE, fmtBytes, localDayKey } from './kit.js';

export function dayKey(iso) {
  // Local wall-clock bucketing (kit localDayKey), never the UTC slice — an
  // evening photo must not land on tomorrow's stack.
  return iso ? localDayKey(iso) : '';
}

export function fmtDay(key) {
  if (!key) return 'Undated';
  if (key === localDayKey(new Date())) return 'Today';
  if (key === localDayKey(new Date(Date.now() - 86400000))) return 'Yesterday';
  try {
    return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return key;
  }
}

export function fmtMonth(key) {
  if (!key) return 'Undated';
  try {
    return new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return key;
  }
}

// What a datetime-local input wants: local wall-clock, minute precision.
export function toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Byte size straight off the asset row when the vault recorded one,
// otherwise recovered from the base64 payload length.
export function assetBytes(asset) {
  const recorded = asset.byte_size ?? asset.bytes ?? asset.size_bytes;
  if (typeof recorded === 'number') return recorded;
  const uri = asset.content_uri;
  if (typeof uri === 'string' && uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    if (comma > 0 && uri.slice(0, comma).includes('base64')) {
      return Math.round(((uri.length - comma - 1) * 3) / 4);
    }
  }
  return null;
}

// Human labels for the EXIF keys `packages/vault/src/blob/pipeline.ts`'s
// `parseJpegExif`/`extractBlobMeta` may write into `media_media_asset.
// exif_json` at upload — plus a few common camera fields (make/model/iso/
// aperture/shutter/focal length) that infra doesn't populate YET but a
// future codec plug-in could (see enrich.ts's own "same queries" note on
// the phash sidecar for the same forward-looking shape). Reading a key this
// vault never writes just means that row never renders — see exifRows below.
const EXIF_LABELS = {
  make: 'Camera make',
  model: 'Camera model',
  lens: 'Lens',
  iso: 'ISO',
  f_number: 'Aperture',
  aperture: 'Aperture',
  exposure_time: 'Shutter',
  shutter_speed: 'Shutter',
  focal_length: 'Focal length',
  codec: 'Codec',
  title: 'Embedded title',
  artist: 'Artist',
};

/**
 * The Lightbox details panel's rows: whatever `asset.exif_json` actually
 * carries (issue #352 — today that's captured time/GPS from
 * packages/vault/src/blob/pipeline.ts's minimal EXIF walk, never camera
 * make/model/ISO/aperture — this vault doesn't parse those tags yet) plus
 * the always-available dimensions/size/captured-time/type every asset row
 * carries regardless of EXIF. Degrades to an empty array when nothing is
 * known — the panel then shows its own "nothing to show" copy.
 */
export function exifRows(asset) {
  const rows = [];
  let exif = null;
  if (typeof asset.exif_json === 'string') {
    try {
      exif = JSON.parse(asset.exif_json);
    } catch {
      exif = null;
    }
  } else if (asset.exif_json && typeof asset.exif_json === 'object') {
    exif = asset.exif_json;
  }
  if (exif) {
    const camera = [exif.make, exif.model].filter(Boolean).join(' ');
    if (camera) rows.push({ label: 'Camera', value: camera });
    const aperture = exif.f_number ?? exif.aperture;
    const shutter = exif.exposure_time ?? exif.shutter_speed;
    const exposure = [
      exif.iso != null ? `ISO ${exif.iso}` : null,
      aperture != null ? `ƒ/${aperture}` : null,
      shutter ?? null,
      exif.focal_length != null ? `${exif.focal_length}mm` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    if (exposure) rows.push({ label: 'Exposure', value: exposure });
    // Any OTHER labeled EXIF key this vault might carry beyond the two
    // folded groups above (lens today; forward-compatible with whatever a
    // future codec plug-in adds) — see EXIF_LABELS' own doc comment.
    const FOLDED = new Set([
      'make',
      'model',
      'iso',
      'f_number',
      'aperture',
      'exposure_time',
      'shutter_speed',
      'focal_length',
    ]);
    for (const [key, label] of Object.entries(EXIF_LABELS)) {
      if (FOLDED.has(key)) continue;
      if (exif[key] != null) rows.push({ label, value: String(exif[key]) });
    }
    if (exif.has_location && exif.latitude != null && exif.longitude != null) {
      const lat = Number(exif.latitude).toFixed(5);
      const lon = Number(exif.longitude).toFixed(5);
      rows.push({
        label: 'Location',
        value: `${lat}, ${lon}`,
        href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`,
      });
    } else if (exif.has_location) {
      rows.push({ label: 'Location', value: 'recorded, not shared' });
    }
  }
  if (asset.width && asset.height) {
    rows.push({ label: 'Dimensions', value: `${asset.width} × ${asset.height}` });
  }
  if (Number.isFinite(Number(asset.duration_s))) {
    const seconds = Math.round(Number(asset.duration_s));
    const minutes = Math.floor(seconds / 60);
    rows.push({ label: 'Duration', value: `${minutes}:${String(seconds % 60).padStart(2, '0')}` });
  }
  const size = fmtBytes(assetBytes(asset));
  if (size) rows.push({ label: 'File size', value: size });
  const captured = asset.captured_at ?? asset.taken_at;
  if (captured) {
    const d = new Date(captured);
    if (!Number.isNaN(d.getTime())) {
      // `dateStyle`/`timeStyle` can't be mixed with component options like
      // `weekday` (Intl.DateTimeFormat throws) — `dateStyle: 'full'` already
      // spells out the weekday on its own.
      rows.push({
        label: 'Captured',
        value: d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }),
      });
    }
  }
  if (asset.media_type) rows.push({ label: 'Type', value: asset.media_type });
  return rows;
}

// The blob custody projection (issue #352 phase 3/4, blob/custody.ts) in
// owner-facing words + a tone the CSS keys off (custody-ok/custody-warn/
// custody-danger). Returns null for a custody-less row (asset has no
// content_id resolvable to `blob_custody_state`, or the standing sweep
// hasn't run yet) — the caller renders nothing rather than a wrong claim.
const CUSTODY_META = {
  'local-only': { label: 'On this device only', tone: 'warn' },
  replicated: { label: 'Backed up', tone: 'ok' },
  'remote-only': { label: 'Only in the cloud', tone: 'warn' },
  missing: { label: 'Missing — needs attention', tone: 'danger' },
};

export function custodyMeta(state) {
  return CUSTODY_META[state] ?? null;
}

export function isVideoAsset(asset) {
  const uri = asset.content_uri;
  if (typeof uri === 'string' && uri.startsWith('data:video')) return true;
  return asset.kind === 'video' || String(asset.media_type ?? '').startsWith('video/');
}

export function isAudioAsset(asset) {
  const uri = asset.content_uri;
  if (typeof uri === 'string' && uri.startsWith('data:audio')) return true;
  return asset.kind === 'audio' || String(asset.media_type ?? '').startsWith('audio/');
}

export function isRenderableUri(uri) {
  return (
    typeof uri === 'string' &&
    (uri.startsWith('http:') ||
      uri.startsWith('https:') ||
      uri.startsWith('data:image') ||
      uri.startsWith('data:video') ||
      uri.startsWith('data:audio') ||
      // Blob-backed bytes arrive as same-origin vault URLs (issue #296).
      uri.startsWith(BLOB_ROUTE + '/'))
  );
}

// Joins truthy class fragments — the same `.tile-wrap selected faved`-style
// composition the Lit port used, unchanged by the move to JSX (`className=`
// still just wants a string).
export const cls = (...parts) => parts.filter(Boolean).join(' ');
