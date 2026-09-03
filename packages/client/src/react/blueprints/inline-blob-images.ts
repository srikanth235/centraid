import { authorizeBlobUrl, SCOPE_ATTR } from "./blob-auth.js";

const BLOB_PREFIX = "/centraid/_vault/blobs";
const BG_URL_RE =
  /url\((?<quote>['"]?)(?<url>\/centraid\/_vault\/blobs[^'")]*)\k<quote>\)/u;
const BG_OBJECT_URL_RE = /url\((?<quote>['"]?)(?<url>blob:[^'")]*)\k<quote>\)/u;

const ORIGIN_SRC = "blobOriginSrc";
const ORIGIN_PREFETCH = "blobOriginPrefetch";
const ORIGIN_BG = "blobOriginBg";
const BG_SELECTOR = '[style*="_vault/blobs"], [data-blob-origin-bg]';

const FRAMED_SELECTOR = "iframe, video, audio";

const PENDING_ATTR = "data-blob-pending";

interface Assigned {
  source: string;
  objectUrl: string; // the blob: URL we assigned (may be '' while in flight)
}

function scopeOf(el: Element): string | undefined {
  const owner = el.closest(`[${SCOPE_ATTR}]`);
  const value = owner?.getAttribute(SCOPE_ATTR);
  return value ? value : undefined;
}

function sourceKey(scope: string | undefined, pathname: string): string {
  return `${scope ?? ""}\u0000${pathname}`;
}

/** @public */
export function installInlineBlobImages(root: HTMLElement): () => void {
  const srcMap = new WeakMap<Element, Assigned>();
  const prefetchMap = new WeakMap<Element, Assigned>();
  const bgMap = new WeakMap<Element, Assigned>();
  const live = new Set<string>(); // every un-revoked object URL, for teardown
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
      // Intentionally empty.
    }
  };

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
          // Intentionally empty.
        }
        return;
      }
      if (rec.objectUrl) revoke(rec.objectUrl);
      live.add(objectUrl);
      map.set(el, { source, objectUrl });
      set(objectUrl);
    });
  };

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
    if (pre?.startsWith(BLOB_PREFIX))
      authorize(img, prefetchMap, ORIGIN_PREFETCH, pre, setPrefetch(img));
    if (src?.startsWith(BLOB_PREFIX)) {
      authorize(img, srcMap, ORIGIN_SRC, src, setSrc(img));
      return;
    }
    let srcRecovered = false;
    if (isStaleObjectUrl(src)) {
      const origin = img.dataset[ORIGIN_SRC] ?? img.dataset[ORIGIN_PREFETCH];
      if (origin) {
        authorize(img, srcMap, ORIGIN_SRC, origin, setSrc(img));
        srcRecovered = true;
      }
    }
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
