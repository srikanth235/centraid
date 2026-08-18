// Generic blob-image authorizer for inline apps (issue #505 Phase 4).
//
// A bundled app painting vault media points an `<img>` `src`, media-observer's
// staged `data-prefetch-src`, or a CSS `background-image: url(…)` at a RELATIVE
// `/centraid/_vault/blobs/<id>` URL. Served, that resolves same-origin; inline
// the app lives in the shell document (bearer-auth only, and desktop runs from
// `file://`), so those references carry no credential and fail to load — which,
// for the photos grid, trips each tile's `onerror` into a placeholder.
//
// The element layer's `renderAttachments` already authorizes the blob refs
// inside an attachment STRIP — it has to, because a non-image tile renders a
// download `<a href>`, which this module does not watch. This module covers
// every OTHER blob surface generically: a
// `MutationObserver` over the mounted app subtree swaps each blob reference to an
// authed `blob:` object URL (through `authorizeBlobUrl`). Rewriting
// `data-prefetch-src` BEFORE media-observer copies it into `src` is what keeps
// the lazy grid from ever loading an unauthorized URL (and firing `onerror`) —
// enforced, not merely hoped for, by the `data-blob-pending` stamp below, which
// makes the app hold the staged→`src` promotion until this module has settled;
// a tile that lands directly in `src` (saveData / no IntersectionObserver) is
// swapped best-effort after the fact, and the same stamp keeps its `error` from
// being read as a verdict meanwhile. One install per app mount (from
// InlineAppRoute), so every inline app benefits, not just photos. Every object
// URL is tracked and revoked on teardown and on replacement, so nothing leaks.
//
// Revocation and re-authorization are two halves of one contract: teardown
// revokes, so a re-install MUST be able to bring an already-swapped element back
// (see the origin stamps below). Callers own the other half — a teardown must
// mean a real unmount, never a re-run of a mount callback (InlineAppRoute).
// Import from the leaf `blob-auth.js` module, never through a barrel: this
// module is eager (InlineAppRoute → App), so a barrel import would drag its
// whole graph into the shell's boot chunk. See blob-auth.ts.
import { authorizeBlobUrl, SCOPE_ATTR } from "./blob-auth.js";

const BLOB_PREFIX = "/centraid/_vault/blobs";
// `background-image: url(/centraid/_vault/blobs/…)` — optional quotes, captured.
const BG_URL_RE =
  /url\((?<quote>['"]?)(?<url>\/centraid\/_vault\/blobs[^'")]*)\k<quote>\)/u;
// The same shape once WE have swapped it — `background-image: url("blob:…")`.
const BG_OBJECT_URL_RE = /url\((?<quote>['"]?)(?<url>blob:[^'")]*)\k<quote>\)/u;

// Once a sink holds a `blob:` object URL, the vault pathname it was authorized
// FROM is gone from the DOM — `scan*` would see only `blob:…`, which does not
// start with BLOB_PREFIX, and skip the element forever. So each swap stamps its
// origin pathname back onto the element (one `data-*` key per sink). A LATER
// install (or this one, after a replacement revoke) can then tell a live object
// URL from a dead one and re-authorize the dead one from its stamp instead of
// leaving the image pointed at a revoked URL — the blank-photo-grid bug, where
// the tiles that had already been swapped were exactly the ones left blank.
// These keys are deliberately NOT in the observer's `attributeFilter`, so
// stamping cannot feed the observer back into itself.
const ORIGIN_SRC = "blobOriginSrc";
const ORIGIN_PREFETCH = "blobOriginPrefetch";
const ORIGIN_BG = "blobOriginBg";
/** `scanTree`'s selector for a background sink — pending OR already swapped. */
const BG_SELECTOR = '[style*="_vault/blobs"], [data-blob-origin-bg]';

/**
 * THE OTHER SRC-BEARING SINKS: an embedded document and time-based media.
 *
 * This module used to watch `<img>` and CSS backgrounds only, which was every
 * blob surface the photos grid had. It is not every blob surface the product
 * has: Docs' stage renders a PDF in an `<iframe>` and sound and video in
 * `<video>`/`<audio>`, all three pointed at the same relative
 * `/centraid/_vault/blobs/<id>` path. Un-authorized, that path resolves to the
 * SPA's own index.html — so the PDF frame painted a BLANK WHITE PAGE and the
 * players failed silently, which reads as "the file is empty" rather than
 * "nobody asked for it with a credential".
 *
 * They take the same swap as an `<img>`'s `src`, minus the staged-prefetch
 * dance: there is no lazy grid behind them, so the whole reference lands in
 * `src` at once. A `<video poster>` is deliberately NOT covered — the poster is
 * decoration over bytes this module now authorizes properly.
 */
const FRAMED_SELECTOR = "iframe, video, audio";

// The claim stamp, and the other half of the ordering contract with the apps.
//
// Stamping an origin is not enough on its own: the browser begins loading a
// relative vault path the instant it lands in `src`, and off the gateway origin
// (the installable web PWA over the iroh tunnel; desktop's `file://` shell)
// that path resolves to the SPA's own index.html. The `<img>` gets HTML, fires
// `error`, and an app that reads `error` as "this asset is broken" tears the
// tile down before authorization can possibly finish — the grey photo grid.
//
// So while an authorization is in flight the element carries
// `data-blob-pending="1"`, and apps use it two ways (photos'
// media-observer.ts / media.ts):
//   * do not promote a staged raw vault path into `src` while it is set, and
//   * do not treat an `error` on a raw vault path as terminal while it is set.
// The stamp is cleared the moment the authorization settles EITHER way, and a
// failure additionally re-fires `error` (see `reportFailure`) so the app's own
// terminal path — a placeholder — still runs. Deliberately NOT in the
// observer's `attributeFilter`, so stamping cannot feed it back into itself.
const PENDING_ATTR = "data-blob-pending";

interface Assigned {
  /** `<scope>\0<pathname>` — see `sourceKey`. */
  source: string;
  objectUrl: string; // the blob: URL we assigned (may be '' while in flight)
}

/**
 * The scope that owns an element's bytes: its own `data-scope`, or the nearest
 * ancestor carrying one (a multi-scope app stamps whole sections). Undefined
 * means a single-scope surface, which addresses the ambient scope.
 */
function scopeOf(el: Element): string | undefined {
  const owner = el.closest(`[${SCOPE_ATTR}]`);
  const value = owner?.getAttribute(SCOPE_ATTR);
  return value ? value : undefined;
}

/**
 * The dedupe/staleness key. It MUST include the scope: the same blob pathname
 * in two mounted scopes is two different images (content ids are per-vault and
 * collide across them by design, issue #599), so keying by pathname alone would
 * let a tile keep the other scope's bytes.
 */
function sourceKey(scope: string | undefined, pathname: string): string {
  return `${scope ?? ""}\u0000${pathname}`;
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
  // In-flight authorizations per element. A COUNT, not a flag: one element can
  // have both its `src` and its `data-prefetch-src` in flight, and clearing the
  // stamp when the first settles would unblock the app too early.
  const inflight = new WeakMap<Element, number>();
  let stopped = false;

  const markPending = (el: Element): void => {
    inflight.set(el, (inflight.get(el) ?? 0) + 1);
    if (el instanceof HTMLElement) el.setAttribute(PENDING_ATTR, "1");
  };
  const settlePending = (el: Element): void => {
    const remaining = Math.max(0, (inflight.get(el) ?? 1) - 1);
    inflight.set(el, remaining);
    if (remaining === 0 && el instanceof HTMLElement)
      el.removeAttribute(PENDING_ATTR);
  };

  /**
   * Authorization is over and it failed. An `<img>` still pointed at the raw
   * vault path will never load, and under the pending contract above the app is
   * WAITING on this outcome rather than reacting to the failed raw load — so
   * hand it back the `error` it deferred, now that the stamp is gone and the
   * event is terminal.
   */
  const reportFailure = (el: Element): void => {
    if (!(el instanceof HTMLImageElement) || !el.isConnected) return;
    if (!el.getAttribute("src")?.startsWith(BLOB_PREFIX)) return;
    el.dispatchEvent(new Event("error"));
  };

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
    originKey: string,
    pathname: string,
    set: (url: string) => void
  ): void => {
    const scope = scopeOf(el);
    const source = sourceKey(scope, pathname);
    const prev = map.get(el);
    if (prev?.source === source) return;
    // Stamp the origin BEFORE the fetch: even if this authorization never
    // settles, the element now says where its bytes come from, so the next
    // install can pick it up.
    if (el instanceof HTMLElement) el.dataset[originKey] = pathname;
    map.set(el, { source, objectUrl: prev?.objectUrl ?? "" });
    markPending(el);
    void authorizeBlobUrl(pathname, scope).then((objectUrl) => {
      settlePending(el);
      if (!objectUrl) {
        if (!stopped) reportFailure(el);
        return;
      }
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

  /**
   * A `blob:` reference this install does NOT own: either a URL a previous
   * install created and revoked on its teardown, or one we revoked when the
   * sink was replaced. Either way the bytes behind it are gone — the browser
   * answers `ERR_FILE_NOT_FOUND` — so the element must be re-authorized, not
   * skipped.
   */
  const isStaleObjectUrl = (url: string | null | undefined): url is string =>
    !!url && url.startsWith("blob:") && !live.has(url);

  const setPrefetch = (img: HTMLImageElement) => (url: string) => {
    img.dataset.prefetchSrc = url;
  };
  const setSrc = (img: HTMLImageElement) => (url: string) =>
    img.setAttribute("src", url);

  const scanImg = (img: HTMLImageElement): void => {
    const pre = img.dataset.prefetchSrc;
    const src = img.getAttribute("src");
    // --- pending references: the un-authorized `/…/blobs` values apps paint ---
    if (pre?.startsWith(BLOB_PREFIX))
      authorize(img, prefetchMap, ORIGIN_PREFETCH, pre, setPrefetch(img));
    if (src?.startsWith(BLOB_PREFIX)) {
      authorize(img, srcMap, ORIGIN_SRC, src, setSrc(img));
      return;
    }
    // --- recovery: sinks holding a `blob:` URL whose bytes are gone ---
    let srcRecovered = false;
    if (isStaleObjectUrl(src)) {
      // A tile that took the lazy path never had a `/…/blobs` value in `src` —
      // media-observer copied the already-authed staged URL straight in — so
      // its origin is only recorded under the prefetch stamp.
      const origin = img.dataset[ORIGIN_SRC] ?? img.dataset[ORIGIN_PREFETCH];
      if (origin) {
        authorize(img, srcMap, ORIGIN_SRC, origin, setSrc(img));
        srcRecovered = true;
      }
    }
    // Once `src` shows live bytes the staged copy is vestigial — media-observer
    // has already spent it — so re-authorizing it would fetch the same photo
    // twice per tile. If media-observer ever spends it again, the resulting
    // stale `src` comes straight back through the branch above.
    if (srcRecovered || (src && live.has(src))) return;
    if (!isStaleObjectUrl(pre)) return;
    const origin = img.dataset[ORIGIN_PREFETCH];
    if (origin)
      authorize(img, prefetchMap, ORIGIN_PREFETCH, origin, setPrefetch(img));
  };

  const scanFramed = (el: HTMLElement): void => {
    const set = (url: string): void => el.setAttribute("src", url);
    const src = el.getAttribute("src");
    if (src?.startsWith(BLOB_PREFIX)) {
      authorize(el, srcMap, ORIGIN_SRC, src, set);
      return;
    }
    // Recovery, same contract as an image's: a `blob:` URL a previous install
    // revoked is dead bytes, and the stamp says where to fetch them again.
    if (!isStaleObjectUrl(src)) return;
    const origin = el.dataset[ORIGIN_SRC];
    if (origin) authorize(el, srcMap, ORIGIN_SRC, origin, set);
  };

  const scanBackground = (el: HTMLElement): void => {
    const set = (url: string): void => {
      el.style.backgroundImage = `url("${url}")`;
    };
    const bg = el.style.backgroundImage;
    if (bg?.includes(BLOB_PREFIX)) {
      const match = BG_URL_RE.exec(bg);
      if (!match) return;
      authorize(el, bgMap, ORIGIN_BG, match[2]!, set);
      return;
    }
    if (!isStaleObjectUrl(BG_OBJECT_URL_RE.exec(bg ?? "")?.[2])) return;
    const origin = el.dataset[ORIGIN_BG];
    if (origin) authorize(el, bgMap, ORIGIN_BG, origin, set);
  };

  const scanEl = (el: Element): void => {
    if (el instanceof HTMLImageElement) scanImg(el);
    if (!(el instanceof HTMLElement)) return;
    if (el.matches(FRAMED_SELECTOR)) scanFramed(el);
    // The stamp keeps an ALREADY-swapped cover in scope: its inline style now
    // reads `url("blob:…")`, which no longer mentions the vault prefix.
    if (
      el.style.backgroundImage.includes(BLOB_PREFIX) ||
      el.dataset[ORIGIN_BG]
    ) {
      scanBackground(el);
    }
  };

  const scanTree = (node: Node): void => {
    if (node instanceof HTMLImageElement) scanImg(node);
    if (!(node instanceof Element)) return;
    scanEl(node);
    for (const img of node.querySelectorAll<HTMLImageElement>("img"))
      scanImg(img);
    for (const el of node.querySelectorAll<HTMLElement>(FRAMED_SELECTOR))
      scanFramed(el);
    for (const el of node.querySelectorAll<HTMLElement>(BG_SELECTOR)) {
      scanBackground(el);
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof Element) {
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
    attributeFilter: ["src", "data-prefetch-src", "style", SCOPE_ATTR],
  });
  scanTree(root);

  return () => {
    stopped = true;
    observer.disconnect();
    for (const url of live) revoke(url);
  };
}
