// One-screen media lookahead: swap staged `data-prefetch-src` into `src` a
// viewport before view. Pure imperative DOM (src/photos-media.test.ts).
import { VAULT_BLOB_PATH } from "../_shared/untrusted.ts";

/**
 * Stamp the shell's inline blob authorizer sets while vault-blob auth is in
 * flight. Blueprints never depend on the client package, so this literal is
 * the whole interface (`inline-blob-images.ts` repeats it). On the served
 * iframe path no authorizer is installed — promote immediately.
 */
export const BLOB_PENDING_ATTR = "data-blob-pending";

let viewportObserver: IntersectionObserver | undefined;
const rootObservers = new WeakMap<Element, IntersectionObserver>();
const observerByImage = new WeakMap<HTMLElement, IntersectionObserver>();
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

function applyPending(img: HTMLImageElement, pending: string): void {
  stopObserving(img);
  img.src = pending;
}

/**
 * Hold a raw vault path until the authorizer hands over `blob:` or clears
 * its stamp. Off the gateway origin the path falls through to SPA `index.html`
 * and the tile paints a permanent placeholder if `src` is set too soon.
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
    // Nothing can tell us when the swap lands — paint the raw path.
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
        // Drop the viewport slot; leave `data-prefetch-src` — `promote` may still wait on auth.
        releaseIntersection(target);
        promote(target);
      }
    },
    // Expand the ACTUAL scroll root. A viewport-rooted observer is still clipped by #scrollPane/.picker-grid.
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
