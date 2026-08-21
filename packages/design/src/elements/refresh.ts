// Refresh discipline (data-change + focus) and the two observers beside it.
//
// Every app re-derives what it renders from the vault, so the two cheap
// mistakes are (a) re-reading on every doorbell even when nothing this app
// cares about moved, and (b) re-reading on every window 'focus' even when the
// last read was a moment ago (alt-tab thrash). These wrappers give both a
// common, honest discipline; nothing here holds state beyond one timer and
// one timestamp.

import type { CentraidChangeDetail } from "./host.js";
import { host } from "./host.js";

export interface ReadSubscription {
  managed: boolean;
  unsubscribe: () => void;
}

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms = 200
): (...args: Args) => void {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms) as unknown as number;
  };
}

/**
 * Subscribe to a live read's future values without applying its current value
 * twice. The replica bridge deliberately emits the current value to a new
 * subscriber; callers also await the same read for their initial paint, so
 * this helper consumes that first subscription emission and forwards reruns.
 * Plain-Promise compatibility reads remain unmanaged.
 */
export function subscribeReadUpdates<T = unknown>(
  read: unknown,
  onUpdate: (value: T) => void
): ReadSubscription {
  const subscribable = read as
    | { subscribe?: (cb: (value: T) => void) => () => void }
    | null
    | undefined;
  if (typeof subscribable?.subscribe !== "function") {
    return { managed: false, unsubscribe: () => {} };
  }
  let settled = false;
  let buffered = false;
  let latest: T | undefined;
  const unsubscribe = subscribable.subscribe((value) => {
    if (!settled) {
      latest = value;
      buffered = true;
      return;
    }
    onUpdate(value);
  });
  Promise.resolve(read as PromiseLike<T>)
    .then((initial) => {
      settled = true;
      if (buffered && latest !== initial)
        queueMicrotask(() => onUpdate(latest as T));
    })
    .catch(() => {
      settled = true;
    });
  return { managed: true, unsubscribe };
}

/**
 * Subscribe to the host's change feed with a trailing debounce and a tables
 * filter. `tables` is the set of vault entities this app reads (e.g.
 * `['knowledge.note', 'core.tag']`). A change names the tables it touched; we
 * skip the callback only when that list is NON-EMPTY and misses every declared
 * table — an empty list means "this app acted, re-derive" (post-#286 handler
 * writes carry no tables), so it always fires. Returns an unsubscribe fn.
 */
export function onDataChange(
  tables: string[] | null | undefined,
  cb: (detail: CentraidChangeDetail) => void,
  { debounceMs = 200 }: { debounceMs?: number } = {}
): () => void {
  const want = new Set(tables);
  let timer = 0;
  const pending = new Map<string, CentraidChangeDetail>();
  const unsub = host()?.onChange?.((detail) => {
    const named = detail && Array.isArray(detail.tables) ? detail.tables : null;
    if (named && named.length && want.size && !named.some((t) => want.has(t)))
      return;
    const key =
      detail?.source === "overlay" && typeof detail?.intentId === "string"
        ? `${detail.intentId}:${detail.intentState ?? ""}`
        : "latest";
    pending.set(key, detail);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const details = [...pending.values()];
      pending.clear();
      details.forEach(cb);
    }, debounceMs) as unknown as number;
  });
  return () => {
    clearTimeout(timer);
    pending.clear();
    unsub?.();
  };
}

/**
 * Refresh on window 'focus', but skip when the last focus-refresh fired less
 * than `minIntervalMs` ago — a blur/focus flurry (alt-tab, devtools) must not
 * re-hit the vault each time. Independent of onDataChange's timer: a real
 * change still refreshes immediately. The gate never applies while a consent
 * banner (`#consentBanner`) is up: focus is the recovery path when access was
 * just re-granted, so a denied app must always re-read on focus. Returns an
 * unsubscribe fn.
 */
export function onFocusRefresh(
  cb: () => void,
  { minIntervalMs = 30000 }: { minIntervalMs?: number } = {}
): () => void {
  let last = 0;
  const onFocus = (): void => {
    const banner = document.querySelector("#consentBanner");
    const recovering = banner && !(banner as HTMLElement).hidden;
    const now = Date.now();
    if (!recovering && now - last < minIntervalMs) return;
    last = now;
    cb();
  };
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
}

/**
 * Track an element's width and call `onNarrow(isNarrow)` whenever it crosses
 * `breakpoint` (or `data-app-width="narrow"` is forced). Prefers a
 * `ResizeObserver` (fires only on real size changes, and pauses when the tab
 * is hidden because layout doesn't change off-screen); falls back to a
 * visibility-gated poll only where RO is unavailable. Fires once immediately.
 * Returns a stop fn.
 */
export function observeWidth(
  target: Element | null,
  breakpoint: number,
  onNarrow: (isNarrow: boolean) => void,
  { pollMs = 250 }: { pollMs?: number } = {}
): () => void {
  const measure = (): void => {
    if (!target) return;
    const forced = document.documentElement.dataset.appWidth === "narrow";
    onNarrow(forced || target.clientWidth < breakpoint);
  };
  measure();
  if (typeof ResizeObserver === "function" && target) {
    const ro = new ResizeObserver(measure);
    ro.observe(target);
    // The forced-narrow knob flips an attribute, not a size — catch it too.
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }
  const id = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    measure();
  }, pollMs);
  return () => clearInterval(id);
}
