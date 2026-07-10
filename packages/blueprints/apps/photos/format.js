// Pure formatting/predicate helpers over an asset row — no DOM, no vault IO,
// no app state. Shared by app.jsx's own orchestrators (refresh/matchesSearch)
// and by every component file that needs to format or classify an asset.
import { BLOB_ROUTE, localDayKey } from './kit.js';

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

export function isVideoAsset(asset) {
  const uri = asset.content_uri;
  if (typeof uri === 'string' && uri.startsWith('data:video')) return true;
  return asset.kind === 'video' || String(asset.media_type ?? '').startsWith('video/');
}

export function isRenderableUri(uri) {
  return (
    typeof uri === 'string' &&
    (uri.startsWith('http:') ||
      uri.startsWith('https:') ||
      uri.startsWith('data:image') ||
      uri.startsWith('data:video') ||
      // Blob-backed bytes arrive as same-origin vault URLs (issue #296).
      uri.startsWith(BLOB_ROUTE + '/'))
  );
}

// Joins truthy class fragments — the same `.tile-wrap selected faved`-style
// composition the Lit port used, unchanged by the move to JSX (`className=`
// still just wants a string).
export const cls = (...parts) => parts.filter(Boolean).join(' ');
