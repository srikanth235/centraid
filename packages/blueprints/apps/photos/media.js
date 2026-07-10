// Tile media: the once-per-mount fill (image/video/placeholder), the thumb
// pipeline that backs it, and the mount guard that makes both safe to call
// from a React callback ref on every render. JSX-free by design — this is
// shared by every component that renders a tile (Grid.jsx, Picker.jsx).
import { isRenderableUri, isVideoAsset } from './format.js';

// Tiles never render the full-resolution bytes — each image is downscaled
// once to this longest edge and cached; the lightbox keeps the original.
export const THUMB_EDGE = 360;

const thumbCache = new Map(); // asset_id -> data URL string | Promise

// Downscale an image URI to THUMB_EDGE on the longest side, JPEG-encoded.
// Anything that refuses (decode error, tainted canvas) falls back to the
// original URI so a tile never goes blank.
export function makeThumb(uri) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const long = Math.max(img.naturalWidth, img.naturalHeight);
      if (!long || long <= THUMB_EDGE) {
        resolve(uri);
        return;
      }
      const scale = THUMB_EDGE / long;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      try {
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      } catch {
        resolve(uri);
      }
    };
    img.onerror = () => resolve(uri);
    img.src = uri;
  });
}

export function setThumbSrc(img, asset) {
  // Blob-backed assets have a server-side variant endpoint (issue #296):
  // the grid loads ~KB thumbs, never full originals. A 404 (no variant
  // produced) falls back to the original bytes — a tile never goes blank.
  if (typeof asset.thumb_uri === 'string') {
    // Known-small assets (longest edge within THUMB_EDGE) never get a thumb
    // staged — upload only downsizes larger ones — so the variant probe is a
    // guaranteed 404: load the original directly instead of paying (and
    // console-logging) a doomed round-trip on every grid render. Assets
    // without recorded dimensions still probe and fall back.
    const knownSmall =
      asset.width != null &&
      asset.height != null &&
      Math.max(asset.width, asset.height) <= THUMB_EDGE;
    if (knownSmall) {
      img.src = asset.content_uri;
      return;
    }
    img.onerror = () => {
      img.onerror = null;
      img.src = asset.content_uri;
    };
    img.src = asset.thumb_uri;
    return;
  }
  const cached = thumbCache.get(asset.asset_id);
  if (typeof cached === 'string') {
    img.src = cached;
    return;
  }
  const pending =
    cached ??
    makeThumb(asset.content_uri).then((thumb) => {
      thumbCache.set(asset.asset_id, thumb);
      return thumb;
    });
  if (!cached) thumbCache.set(asset.asset_id, pending);
  pending.then((thumb) => {
    img.src = thumb;
  });
}

// The visual guts of a tile — shared by the grid, the trash shelf and the
// album picker. Imperative on purpose: `mountMedia` guards it to run once per
// mounted element, exactly like the old code's one-time build.
export function fillTileMedia(tile, asset) {
  if (isRenderableUri(asset.content_uri) && isVideoAsset(asset)) {
    const vid = document.createElement('video');
    vid.src = asset.content_uri;
    vid.muted = true;
    vid.playsInline = true;
    vid.preload = 'metadata';
    vid.setAttribute('aria-label', asset.title ?? 'Video');
    tile.appendChild(vid);
    const badge = document.createElement('span');
    badge.className = 'tile-video-badge';
    badge.textContent = '▶';
    badge.setAttribute('aria-hidden', 'true');
    tile.appendChild(badge);
  } else if (isRenderableUri(asset.content_uri)) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = asset.title ?? asset.kind ?? 'Photo';
    setThumbSrc(img, asset);
    tile.appendChild(img);
  } else {
    tile.classList.add('placeholder');
    const type = document.createElement('span');
    type.className = 'placeholder-type';
    type.textContent = asset.media_type ?? asset.kind ?? 'media';
    const title = document.createElement('span');
    title.className = 'placeholder-title';
    title.textContent = asset.title ?? '';
    tile.append(type, title);
  }
}

// A tile's media fill (fillTileMedia, above) is imperative — image decode,
// video setup, placeholder text — and must run exactly once per mounted
// element. `mountMedia` is that guard, wired through a React callback ref:
// React calls it once when a tile's `<button class="tile">` mounts and again
// (with `null`) on unmount, and the dataset check makes every call besides
// the first a no-op. Pairing this with a stable `key={asset.asset_id}` on the
// tile is what keeps the underlying `<img>`/`<video>` node — and therefore
// its already loaded bytes — alive across refreshes.
export function mountMedia(el, asset) {
  if (!el || el.dataset.mediaFor === asset.asset_id) return;
  el.dataset.mediaFor = asset.asset_id;
  fillTileMedia(el, asset);
}
