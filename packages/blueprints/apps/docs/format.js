// Formatting + file-type helpers — pure functions of their arguments; none
// hold or mutate app state, though `emptyStateFor` below takes `state` as a
// plain argument to derive its copy. Split out of app.jsx so both the
// orchestrator (currentRows' type filter, the upload size-skip message, the
// empty-row copy) and the row/details/quick-look components can call these
// directly instead of threading them all as props.
import { fmtBytes as fmtBytesBase } from './kit.js';
import { I } from './icons.js';

// The drive shows an em dash for absent sizes everywhere it prints bytes.
export const fmtBytes = (n) => fmtBytesBase(n, '—');

export function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const m = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.getFullYear() === new Date().getFullYear() ? m : `${m}, ${d.getFullYear()}`;
  } catch {
    return String(iso).slice(0, 10);
  }
}

export function fmtFull(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return String(iso).slice(0, 10);
  }
}

export function purgeCountdown(iso) {
  if (!iso) return '';
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  if (Number.isNaN(days)) return '';
  if (days <= 0) return 'purges today';
  if (days === 1) return 'purges tomorrow';
  return `purges in ${days} days`;
}

export function typeMeta(mediaType) {
  const t = String(mediaType ?? '').toLowerCase();
  if (t === 'application/pdf')
    return { label: 'PDF', name: 'PDF document', cat: 'pdf', cv: '--c-pdf' };
  if (t.startsWith('image/')) return { label: 'IMG', name: 'Image', cat: 'image', cv: '--c-image' };
  if (
    t.includes('spreadsheet') ||
    t === 'application/vnd.ms-excel' ||
    t === 'text/csv' ||
    t === 'application/vnd.oasis.opendocument.spreadsheet'
  )
    return { label: 'XLS', name: 'Spreadsheet', cat: 'sheet', cv: '--c-sheet' };
  if (
    t.includes('presentation') ||
    t === 'application/vnd.ms-powerpoint' ||
    t === 'application/vnd.oasis.opendocument.presentation'
  )
    return { label: 'PPT', name: 'Presentation', cat: 'slide', cv: '--c-slide' };
  if (
    t.includes('word') ||
    t === 'application/msword' ||
    t === 'application/vnd.oasis.opendocument.text' ||
    t === 'application/rtf' ||
    t.startsWith('text/')
  )
    return { label: 'DOC', name: 'Document', cat: 'doc', cv: '--c-doc' };
  return { label: 'FILE', name: 'File', cat: 'other', cv: '--ink-3' };
}

// The vault's own edit_document precondition (media_type LIKE 'text/%',
// packages/vault/src/commands/documents.ts) — kept in exact lockstep so the
// Edit affordance only ever shows where the command would actually accept
// it. Anything else (including a scanned PDF or an image) takes the
// Replace-file door instead.
export function isTextEditable(doc) {
  return /^text\//i.test(String(doc.media_type ?? ''));
}

// Decode a data: URI's text payload directly, without a network round trip.
// The in-place editor (components/Editor.jsx) needs this for any document
// whose bytes stayed inline (issue #296: small text bodies never rewrite to
// a blob: route) — `fetch()`-ing a data: URI is blocked by the app's own
// CSP (`connect-src` inherits `default-src 'self'`; only `img-src`
// explicitly allows `data:`, which is why an `<img src="data:...">` works
// but a fetch of the same URI does not), so this is the only door, not an
// optimization. UTF-8 safe: base64 payloads decode through a real
// TextDecoder rather than the classic (and multi-byte-unsafe) `atob()`
// alone.
export function decodeDataUri(uri) {
  const s = String(uri ?? '');
  if (!s.startsWith('data:')) return null;
  const comma = s.indexOf(',');
  if (comma < 0) return null;
  const meta = s.slice(0, comma);
  const payload = s.slice(comma + 1);
  try {
    if (meta.includes(';base64')) {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

export function loadable(uri) {
  // Same-origin vault blob URLs (issue #296) render everywhere data: did —
  // and in iframes BETTER: `default-src 'self'` allows them where data:
  // PDFs went blank.
  return /^(data:|https?:|\/centraid\/_vault\/blobs\/)/i.test(String(uri ?? ''));
}
export function isImage(doc) {
  return String(doc.media_type ?? '').startsWith('image/') && loadable(doc.content_uri);
}
export function tintBg(cv, pct) {
  return `color-mix(in oklab, var(${cv}) ${pct}%, transparent)`;
}

// The row list's empty-state copy, as plain data — one per nav/search/type
// combination, in the same precedence order the old inline cascade used.
// `needsUpload` flags the two spots that also want an "Upload…" action
// button, which stays a DOM-imperative `h()` node built by the caller (the
// click handler needs the live `#uploadInput`, not a prop this pure function
// could carry).
export function emptyStateFor(state, hasActiveFiles) {
  if (state.nav.kind === 'starred' && state.type === 'all')
    return {
      icon: I.star,
      title: 'Nothing starred yet',
      sub: 'Star a document from its menu to pin it here. It is one star across your vault — photos you favorite land here too.',
    };
  if (state.search.trim())
    return {
      icon: I.allDocs,
      title: 'No matches',
      sub: `No documents match “${state.search.trim()}”. Try fewer words.`,
    };
  if (state.nav.kind === 'trash')
    return {
      icon: I.trash,
      title: 'Trash is empty',
      sub: 'Trashed documents purge after about 30 days.',
    };
  if (state.type !== 'all')
    return {
      icon: I.allDocs,
      title: 'No matches',
      sub: 'No documents of this type here. Clear the filter to see everything.',
    };
  if (state.nav.kind === 'folder')
    return {
      icon: I.folder,
      title: 'Empty folder',
      sub: 'Nothing filed here yet.',
      needsUpload: 'Upload to this folder',
    };
  if (!hasActiveFiles)
    return {
      icon: I.allDocs,
      title: 'Your drive is empty',
      sub: 'Leases, IDs, warranties, tax forms — file the important stuff here.',
      needsUpload: 'Upload your first document',
    };
  return { icon: I.allDocs, title: 'Nothing here', sub: 'No documents to show.' };
}

export function extOf(doc) {
  const t = String(doc.title ?? '');
  const dot = t.lastIndexOf('.');
  if (dot > 0 && dot < t.length - 1) return `.${t.slice(dot + 1).toLowerCase()}`;
  return typeMeta(doc.media_type).label.toLowerCase();
}
