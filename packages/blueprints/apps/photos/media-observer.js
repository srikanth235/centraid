let viewportObserver;
const rootObservers = new WeakMap();
const observerByImage = new WeakMap();
let detachedMediaObserver;

function stopObserving(img) {
  observerByImage.get(img)?.unobserve(img);
  observerByImage.delete(img);
  delete img.dataset.prefetchSrc;
}

function scrollRootFor(img) {
  for (let node = img.parentElement; node && node !== document.documentElement; ) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(`${style.overflow} ${style.overflowY}`)) return node;
    node = node.parentElement;
  }
  return null;
}

function createObserver(root) {
  return new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target;
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

function observerFor(root) {
  if (!root) return (viewportObserver ??= createObserver(null));
  let observer = rootObservers.get(root);
  if (!observer) {
    observer = createObserver(root);
    rootObservers.set(root, observer);
  }
  return observer;
}

function ensureDetachedCleanup() {
  if (detachedMediaObserver || typeof MutationObserver !== 'function') return;
  detachedMediaObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('img[data-prefetch-src]')) stopObserving(node);
        for (const img of node.querySelectorAll('img[data-prefetch-src]')) stopObserving(img);
      }
    }
  });
  detachedMediaObserver.observe(document.documentElement, { childList: true, subtree: true });
}

export function stopNextScreenObservation(img) {
  stopObserving(img);
}

export function observeNextScreen(img, src) {
  stopObserving(img);
  const saveData = navigator.connection?.saveData === true;
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
