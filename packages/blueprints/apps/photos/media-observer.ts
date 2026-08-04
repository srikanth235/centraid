// One-screen media lookahead: an IntersectionObserver per real scroll root
// that swaps a tile's staged `data-prefetch-src` into `src` a viewport before
// it enters view, plus a MutationObserver that releases detached tiles. Pure
// imperative DOM — no app state, no kit imports — so it stays unit-testable
// (see src/photos-media.test.ts).
import { VAULT_BLOB_PATH } from "../_shared/untrusted.ts";

/**
 * The attribute the shell's inline blob authorizer stamps on an element while
 * an authorization for its `/centraid/_vault/blobs/…` reference is in flight
 * (`packages/client/src/react/blueprints/inline-blob-images.ts` owns the other
 * half of this contract and repeats the same literal — blueprints never depend
 * on the client package, so the string is the whole interface, exactly like
 * `VAULT_BLOB_PATH` / `BLOB_PREFIX`).
 *
 * Presence of the stamp is the ONLY reliable signal that a raw vault path is
 * about to be rewritten into an authed `blob:` URL. On the SERVED path (the
 * blueprint running in an iframe the gateway itself serves) no authorizer is
 * installed, the stamp never appears, and promotion stays immediate — the
 * relative path resolves same-origin there, as it always has.
 */
export const BLOB_PENDING_ATTR = "data-blob-pending";

let viewportObserver: IntersectionObserver | undefined;
const rootObservers = new WeakMap<Element, IntersectionObserver>();
const observerByImage = new WeakMap<HTMLElement, IntersectionObserver>();
// The per-image watcher that resumes a promotion held for authorization.
const promotionWatchers = new WeakMap<HTMLElement, MutationObserver>();
let detachedMediaObserver: MutationObserver | undefined;

function releaseIntersection(img: HTMLElement): void {
  observerByImage.get(img)?.unobserve(img);
  observerByImage.delete(img);
}

function stopObserving(img: HTMLElement): void {
  releaseIntersection(img);
  const watcher = promotionWatchers.get(img);
  if (watcher) {
    watcher.disconnect();
    promotionWatchers.delete(img);
  }
  delete img.dataset.prefetchSrc;
}

/** Commit a staged source: stop every observation of this tile, then paint. */
function applyPending(img: HTMLImageElement, pending: string): void {
  stopObserving(img);
  img.src = pending;
}

/**
 * The tile has scrolled into range — paint the staged source, UNLESS it is a
 * raw vault path the shell's authorizer has claimed.
 *
 * Off the gateway origin (the installable web PWA, which reaches the gateway
 * over the iroh tunnel; desktop, which runs the shell from `file://`) a
 * `/centraid/_vault/blobs/…` path is not the gateway at all — it falls through
 * to the SPA's own `index.html`. The `<img>` receives HTML, fires `error`, and
 * the tile paints a permanent placeholder — all of it BEFORE the authorizer's
 * fetch can settle. Holding the promotion is what stops the raw path from ever
 * reaching `src` on that host; the watcher resumes when the authorizer either
 * hands over the `blob:` URL or clears its stamp to say it gave up.
 */
function promote(img: HTMLImageElement): void {
  const pending = img.dataset.prefetchSrc;
  if (!pending) {
    stopObserving(img);
    return;
  }
  if (
    pending.startsWith(VAULT_BLOB_PATH) &&
    img.getAttribute(BLOB_PENDING_ATTR) === "1"
  ) {
    holdForAuthorization(img, pending);
    return;
  }
  applyPending(img, pending);
}

function holdForAuthorization(img: HTMLImageElement, pending: string): void {
  if (promotionWatchers.has(img)) return;
  if (typeof MutationObserver !== "function") {
    // Nothing can tell us when the swap lands, so behave as before: paint the
    // raw path and let the app's own `error` handling decide.
    applyPending(img, pending);
    return;
  }
  const watcher = new MutationObserver(() => {
    promote(img);
  });
  promotionWatchers.set(img, watcher);
  watcher.observe(img, {
    attributes: true,
    attributeFilter: ["data-prefetch-src", BLOB_PENDING_ATTR],
  });
}

function scrollRootFor(img: HTMLElement): HTMLElement | null {
  for (
    let node = img.parentElement;
    node && node !== document.documentElement;
  ) {
    const style = getComputedStyle(node);
    if (/(?:auto|scroll|overlay)/u.test(`${style.overflow} ${style.overflowY}`))
      return node;
    node = node.parentElement;
  }
  return null;
}

function createObserver(root: Element | null): IntersectionObserver {
  return new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target as HTMLImageElement;
        // Give up the viewport slot immediately (this tile is decided), but
        // leave `data-prefetch-src` in place — `promote` may still be waiting
        // on the shell's authorizer to rewrite it.
        releaseIntersection(target);
        promote(target);
      }
    },
    // Expand the ACTUAL scroll root by one viewport. A viewport-rooted
    // observer is still clipped by #scrollPane/.picker-grid, so rootMargin
    // alone cannot prefetch rows below those overflow boundaries.
    { root, rootMargin: "100% 0px" }
  );
}

function observerFor(root: HTMLElement | null): IntersectionObserver {
  if (!root) return (viewportObserver ??= createObserver(null));
  let observer = rootObservers.get(root);
  if (!observer) {
    observer = createObserver(root);
    rootObservers.set(root, observer);
  }
  return observer;
}

function ensureDetachedCleanup(): void {
  if (detachedMediaObserver || typeof MutationObserver !== "function") return;
  detachedMediaObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches("img[data-prefetch-src]"))
          stopObserving(node as HTMLElement);
        for (const img of node.querySelectorAll<HTMLImageElement>(
          "img[data-prefetch-src]"
        )) {
          stopObserving(img);
        }
      }
    }
  });
  detachedMediaObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

export function stopNextScreenObservation(img: HTMLImageElement): void {
  stopObserving(img);
}

export function observeNextScreen(img: HTMLImageElement, src: string): void {
  stopObserving(img);
  const connection = (navigator as { connection?: { saveData?: boolean } })
    .connection;
  const saveData = connection?.saveData === true;
  if (saveData || typeof IntersectionObserver !== "function") {
    img.src = src;
    return;
  }
  ensureDetachedCleanup();
  img.dataset.prefetchSrc = src;
  const observer = observerFor(scrollRootFor(img));
  observerByImage.set(img, observer);
  observer.observe(img);
}
