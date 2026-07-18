// One-screen media lookahead: an IntersectionObserver per real scroll root
// that swaps a tile's staged `data-prefetch-src` into `src` a viewport before
// it enters view, plus a MutationObserver that releases detached tiles. Pure
// imperative DOM — no app state, no kit imports — so it stays unit-testable
// (see src/photos-media.test.ts).

let viewportObserver: IntersectionObserver | undefined;
const rootObservers = new WeakMap<Element, IntersectionObserver>();
const observerByImage = new WeakMap<HTMLElement, IntersectionObserver>();
let detachedMediaObserver: MutationObserver | undefined;

function stopObserving(img: HTMLElement): void {
  observerByImage.get(img)?.unobserve(img);
  observerByImage.delete(img);
  delete img.dataset.prefetchSrc;
}

function scrollRootFor(img: HTMLElement): HTMLElement | null {
  for (let node = img.parentElement; node && node !== document.documentElement; ) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(`${style.overflow} ${style.overflowY}`)) return node;
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
        const pending = target.dataset.prefetchSrc;
        stopObserving(target);
        if (pending) target.src = pending;
      }
    },
    // Expand the ACTUAL scroll root by one viewport. A viewport-rooted
    // observer is still clipped by #scrollPane/.picker-grid, so rootMargin
    // alone cannot prefetch rows below those overflow boundaries.
    { root, rootMargin: '100% 0px' },
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
  if (detachedMediaObserver || typeof MutationObserver !== 'function') return;
  detachedMediaObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('img[data-prefetch-src]')) stopObserving(node as HTMLElement);
        for (const img of node.querySelectorAll<HTMLImageElement>('img[data-prefetch-src]')) {
          stopObserving(img);
        }
      }
    }
  });
  detachedMediaObserver.observe(document.documentElement, { childList: true, subtree: true });
}

export function stopNextScreenObservation(img: HTMLImageElement): void {
  stopObserving(img);
}

export function observeNextScreen(img: HTMLImageElement, src: string): void {
  stopObserving(img);
  const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
  const saveData = connection?.saveData === true;
  if (saveData || typeof IntersectionObserver !== 'function') {
    img.src = src;
    return;
  }
  ensureDetachedCleanup();
  img.dataset.prefetchSrc = src;
  const observer = observerFor(scrollRootFor(img));
  observerByImage.set(img, observer);
  observer.observe(img);
}
