// Generic blob-image authorizer for inline apps (issue #505 Phase 4).
//
// A bundled app painting vault media points an `<img>` `src`, media-observer's
// staged `data-prefetch-src`, or a CSS `background-image: url(…)` at a RELATIVE
// `/centraid/_vault/blobs/<id>` URL. Served, that resolves same-origin; inline
// the app lives in the shell document (bearer-auth only, and desktop runs from
// `file://`), so those references carry no credential and fail to load — which,
// for the photos grid, trips each tile's `onerror` into a placeholder.
//
// kit-inline's `renderAttachments` already authorizes the blob refs inside an
// attachment STRIP. This module covers every OTHER blob surface generically: a
// `MutationObserver` over the mounted app subtree swaps each blob reference to an
// authed `blob:` object URL (through kit-inline's `authorizeBlobUrl`). Rewriting
// `data-prefetch-src` BEFORE media-observer copies it into `src` is what keeps
// the lazy grid from ever loading an unauthorized URL (and firing `onerror`); a
// tile that lands directly in `src` (saveData / no IntersectionObserver) is
// swapped best-effort after the fact. One install per app mount (from
// InlineAppRoute), so every inline app benefits, not just photos. Every object
// URL is tracked and revoked on teardown and on replacement, so nothing leaks.
import { authorizeBlobUrl } from './kit-inline.js';

const BLOB_PREFIX = '/centraid/_vault/blobs';
// `background-image: url(/centraid/_vault/blobs/…)` — optional quotes, captured.
const BG_URL_RE = /url\((['"]?)(\/centraid\/_vault\/blobs[^'")]*)\1\)/;

interface Assigned {
  source: string; // the blob pathname we authorized
  objectUrl: string; // the blob: URL we assigned (may be '' while in flight)
}

/**
 * Watch `root` for blob-backed image references and authorize them, swapping each
 * to a `blob:` object URL. Returns a teardown that stops observing and revokes
 * every object URL it created. Wired from InlineAppRoute per app mount
 * (invisible to knip's import graph because it is called through a ref
 * callback).
 * @public
 */
export function installInlineBlobImages(root: HTMLElement): () => void {
  // Per-sink records (an element can carry BOTH an `src` and a `data-prefetch-
  // src` blob at different phases, so they cannot share one record).
  const srcMap = new WeakMap<Element, Assigned>();
  const prefetchMap = new WeakMap<Element, Assigned>();
  const bgMap = new WeakMap<Element, Assigned>();
  const live = new Set<string>(); // every un-revoked object URL, for teardown
  let stopped = false;

  const revoke = (url: string): void => {
    if (!url || !live.delete(url)) return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* already revoked */
    }
  };

  // Authorize `source` for `el` in one sink, then apply it. Dedupes an identical
  // in-flight/settled source, drops a result a newer source has superseded, and
  // revokes the element's previous URL in this sink when it is replaced.
  const authorize = (
    el: Element,
    map: WeakMap<Element, Assigned>,
    source: string,
    set: (url: string) => void,
  ): void => {
    const prev = map.get(el);
    if (prev?.source === source) return;
    map.set(el, { source, objectUrl: prev?.objectUrl ?? '' });
    void authorizeBlobUrl(source).then((objectUrl) => {
      if (!objectUrl) return;
      const rec = map.get(el);
      if (stopped || !rec || rec.source !== source || !el.isConnected) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          /* already revoked */
        }
        return;
      }
      if (rec.objectUrl) revoke(rec.objectUrl);
      live.add(objectUrl);
      map.set(el, { source, objectUrl });
      set(objectUrl);
    });
  };

  const scanImg = (img: HTMLImageElement): void => {
    const pre = img.dataset.prefetchSrc;
    if (pre && pre.startsWith(BLOB_PREFIX)) {
      authorize(img, prefetchMap, pre, (url) => {
        img.dataset.prefetchSrc = url;
      });
    }
    const src = img.getAttribute('src');
    if (src && src.startsWith(BLOB_PREFIX)) {
      authorize(img, srcMap, src, (url) => img.setAttribute('src', url));
    }
  };

  const scanBackground = (el: HTMLElement): void => {
    const bg = el.style.backgroundImage;
    if (!bg || !bg.includes(BLOB_PREFIX)) return;
    const match = BG_URL_RE.exec(bg);
    if (!match) return;
    authorize(el, bgMap, match[2]!, (url) => {
      el.style.backgroundImage = `url("${url}")`;
    });
  };

  const scanEl = (el: Element): void => {
    if (el instanceof HTMLImageElement) scanImg(el);
    if (el instanceof HTMLElement && el.style.backgroundImage.includes(BLOB_PREFIX)) {
      scanBackground(el);
    }
  };

  const scanTree = (node: Node): void => {
    if (node instanceof HTMLImageElement) scanImg(node);
    if (!(node instanceof Element)) return;
    scanEl(node);
    for (const img of node.querySelectorAll<HTMLImageElement>('img')) scanImg(img);
    for (const el of node.querySelectorAll<HTMLElement>('[style*="_vault/blobs"]')) {
      scanBackground(el);
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof Element) {
        scanEl(record.target);
        continue;
      }
      for (const node of record.addedNodes) scanTree(node);
    }
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'data-prefetch-src', 'style'],
  });
  scanTree(root);

  return () => {
    stopped = true;
    observer.disconnect();
    for (const url of live) revoke(url);
  };
}
