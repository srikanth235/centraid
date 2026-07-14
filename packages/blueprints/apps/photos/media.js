// Tile media: the once-per-mount fill (thumb image or placeholder) plus the
// mount guard that makes it safe to call from a React callback ref on every
// render. JSX-free by design — shared by every component that renders a tile
// (Timeline.jsx, Picker.jsx, Duplicates.jsx).
import { isVideoAsset } from './format.js';

// The grid NEVER fetches a full original. Blob-backed assets carry a server
// thumb variant (issue #296) — a few KB; a `data:` URI already rode inline
// with the query row, so painting it costs no relay round trip. Everything
// else — a thumbless remote original, a video (no cheap poster yet; the
// preview ladder is issue #405), an unrenderable kind — gets a lightweight
// placeholder instead of pulling multi-MB bytes just to paint a grid tile.
// The lightbox still loads originals; that is a deliberate user action.
export const THUMB_EDGE = 360;

// The cheap grid source for an asset, or null to render a placeholder. Video
// always placeholders (its bytes load only when the lightbox opens).
export function gridSrc(asset) {
  if (isVideoAsset(asset)) return null;
  if (typeof asset.thumb_uri === 'string') {
    // Known-small blobs never get a thumb staged (upload only downsizes the
    // larger ones), so their `?variant=thumb` probe is a guaranteed 404 — the
    // original is already thumb-sized, so paint it directly and skip the
    // doomed round trip. Assets without recorded dimensions use the thumb and
    // fall back to a placeholder on a real 404.
    const knownSmall =
      asset.width != null &&
      asset.height != null &&
      Math.max(asset.width, asset.height) <= THUMB_EDGE;
    return knownSmall ? asset.content_uri : asset.thumb_uri;
  }
  // A non-blob `data:` URI already travelled inline with the row — render it
  // directly (no network). Any other bare URI would be a full remote original,
  // so it stays a placeholder.
  if (typeof asset.content_uri === 'string' && asset.content_uri.startsWith('data:')) {
    return asset.content_uri;
  }
  return null;
}

function renderPlaceholder(tile, asset) {
  tile.classList.add('is-placeholder');
  const shimmer = document.createElement('span');
  shimmer.className = 'ph-tile-ph';
  shimmer.setAttribute('aria-hidden', 'true');
  tile.appendChild(shimmer);
  if (isVideoAsset(asset)) {
    const badge = document.createElement('span');
    badge.className = 'ph-tile-video-badge';
    badge.setAttribute('aria-hidden', 'true');
    // Inline the same play triangle icons.jsx's PlayIcon draws, so the
    // existing `.ph-tile-video-badge svg` styling applies unchanged.
    badge.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg>';
    tile.appendChild(badge);
  }
}

// The visual guts of a tile — shared by the grid, the trash shelf, the album
// picker and the duplicates shelf. Imperative on purpose: `mountMedia` guards
// it to run once per mounted element, exactly like the old code's one-time
// build.
export function fillTileMedia(tile, asset) {
  const src = gridSrc(asset);
  if (src == null) {
    renderPlaceholder(tile, asset);
    return;
  }
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = asset.title ?? asset.kind ?? 'Photo';
  // Reserve the intrinsic aspect box before the bytes decode (no CLS). The
  // tile container is already fixed-size (justify()), so these attributes only
  // hint the decoder; CSS `object-fit: cover` still fills the box.
  if (asset.width != null && asset.height != null) {
    img.width = asset.width;
    img.height = asset.height;
  }
  // A thumb 404 (variant never produced) must NOT fall back to the original —
  // swap in a placeholder instead of pulling multi-MB bytes into the grid.
  img.onerror = () => {
    img.onerror = null;
    img.remove();
    renderPlaceholder(tile, asset);
  };
  img.src = src;
  tile.appendChild(img);
}

// A tile's media fill (fillTileMedia, above) is imperative — image decode,
// placeholder text — and must run exactly once per mounted element.
// `mountMedia` is that guard, wired through a React callback ref: React calls
// it once when a tile's element mounts and again (with `null`) on unmount, and
// the dataset check makes every call besides the first a no-op. Pairing this
// with a stable `key={asset.asset_id}` on the tile is what keeps the
// underlying `<img>` node — and therefore its already loaded bytes — alive
// across refreshes.
export function mountMedia(el, asset) {
  if (!el || el.dataset.mediaFor === asset.asset_id) return;
  el.dataset.mediaFor = asset.asset_id;
  fillTileMedia(el, asset);
}
