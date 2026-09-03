import { VAULT_BLOB_PATH } from "../_shared/untrusted.ts";

export const BLOB_PENDING_ATTR = "data-blob-pending";

export const MEDIA_ROOT_ATTR = "data-media-root";

const MEDIA_ROOT_SELECTOR = `[${MEDIA_ROOT_ATTR}]`;

const LOOKAHEAD_MARGIN = "100% 0px";
const SAVE_DATA_MARGIN = "0px";

let viewportObserver: IntersectionObserver | undefined;
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
