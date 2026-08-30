// One-screen lookahead: swap staged `data-prefetch-src` into `src` a viewport
// before view (src/photos-media.test.ts).
//
// Observer budget (#883): one IntersectionObserver per scroll root plus ONE
// MutationObserver, for both "auth landed" and "tile detached". Per-image
// observers and `getComputedStyle` root walks cost a style recalc per photo.
import { VAULT_BLOB_PATH } from "../_shared/untrusted.ts";

/** Mirrors the shell's authorizer stamp; blueprints cannot import the client. */
export const BLOB_PENDING_ATTR = "data-blob-pending";

/** `rootMargin` expands only the observer's OWN root, so the lookahead reaches
 *  a screen ahead only when rooted in the pane that actually scrolls. */
export const MEDIA_ROOT_ATTR = "data-media-root";

const MEDIA_ROOT_SELECTOR = `[${MEDIA_ROOT_ATTR}]`;

/** Save-Data narrows the lookahead to the visible rect; skipping staging
 *  instead would load the whole library on that connection. */
const LOOKAHEAD_MARGIN = "100% 0px";
const SAVE_DATA_MARGIN = "0px";

let viewportObserver: IntersectionObserver | undefined;
/** Keyed by margin too: Save-Data changes it. */
const rootObservers = new Map<Element, Map<string, IntersectionObserver>>();
const observerByImage = new WeakMap<HTMLElement, IntersectionObserver>();
const staged = new Set<HTMLImageElement>();
const held = new Set<HTMLImageElement>();
let domWatcher: MutationObserver | undefined;

function releaseIntersection(img: HTMLElement): void {
  observerByImage.get(img)?.unobserve(img);
  observerByImage.delete(img);
}

function stopObserving(img: HTMLElement): void {
  releaseIntersection(img);
  staged.delete(img as HTMLImageElement);
  held.delete(img as HTMLImageElement);
  delete img.dataset.prefetchSrc;
}

function applyPending(img: HTMLImageElement, pending: string): void {
  stopObserving(img);
  img.src = pending;
}

/** Off the gateway origin a raw vault path falls through to SPA `index.html`,
 *  so `src` set before `blob:` lands paints a permanent placeholder. */
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
  if (held.has(img)) return;
  if (!ensureDomWatcher()) {
    applyPending(img, pending);
    return;
  }
  held.add(img);
}

function scrollRootFor(img: HTMLElement): Element | null {
  return img.closest(MEDIA_ROOT_SELECTOR);
}

function createObserver(
  root: Element | null,
  rootMargin: string
): IntersectionObserver {
  return new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target as HTMLImageElement;
        // Leave `data-prefetch-src`: `promote` may still wait on auth.
        releaseIntersection(target);
        promote(target);
      }
    },
    { root, rootMargin }
  );
}

function observerFor(
  root: Element | null,
  rootMargin: string
): IntersectionObserver {
  if (!root) return (viewportObserver ??= createObserver(null, rootMargin));
  let byMargin = rootObservers.get(root);
  if (!byMargin) {
    byMargin = new Map();
    rootObservers.set(root, byMargin);
  }
  let observer = byMargin.get(rootMargin);
  if (!observer) {
    observer = createObserver(root, rootMargin);
    byMargin.set(rootMargin, observer);
  }
  return observer;
}

function ensureDomWatcher(): MutationObserver | undefined {
  if (domWatcher) return domWatcher;
  if (typeof MutationObserver !== "function") return undefined;
  domWatcher = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        const target = record.target as HTMLImageElement;
        if (held.has(target)) promote(target);
        continue;
      }
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
  domWatcher.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-prefetch-src", BLOB_PENDING_ATTR],
  });
  return domWatcher;
}

export function stopNextScreenObservation(img: HTMLImageElement): void {
  stopObserving(img);
}

/** The observers are module singletons; the app root calls this on unmount. */
export function stopMediaObservation(): void {
  for (const img of staged) releaseIntersection(img);
  staged.clear();
  held.clear();
  viewportObserver?.disconnect();
  viewportObserver = undefined;
  for (const byMargin of rootObservers.values())
    for (const observer of byMargin.values()) observer.disconnect();
  rootObservers.clear();
  domWatcher?.disconnect();
  domWatcher = undefined;
}

export function observeNextScreen(img: HTMLImageElement, src: string): void {
  stopObserving(img);
  if (typeof IntersectionObserver !== "function") {
    img.src = src;
    return;
  }
  const connection = (navigator as { connection?: { saveData?: boolean } })
    .connection;
  const saveData = connection?.saveData === true;
  ensureDomWatcher();
  img.dataset.prefetchSrc = src;
  staged.add(img);
  const observer = observerFor(
    scrollRootFor(img),
    saveData ? SAVE_DATA_MARGIN : LOOKAHEAD_MARGIN
  );
  observerByImage.set(img, observer);
  observer.observe(img);
}
