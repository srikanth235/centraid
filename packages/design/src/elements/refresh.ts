// Refresh discipline: skip doorbells for tables this app does not read, and
// skip focus refreshes inside the min interval (alt-tab thrash).

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

// Replica subscribe emits the current value; callers also await it — skip that first.
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

export function onDataChange(
  tables: string[] | null | undefined,
  cb: (detail: CentraidChangeDetail) => void,
  { debounceMs = 200 }: { debounceMs?: number } = {}
): () => void {
  const want = new Set(tables);
  let timer = 0;
  const pending = new Map<string, CentraidChangeDetail>();
  const unsub = host()?.onChange?.((detail) => {
    // Empty `tables` means "this app acted" (#286) — always fire.
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

export function onFocusRefresh(
  cb: () => void,
  { minIntervalMs = 30000 }: { minIntervalMs?: number } = {}
): () => void {
  let last = 0;
  const onFocus = (): void => {
    const banner = document.querySelector("#consentBanner");
    // Bypass the interval while a consent banner is up — focus is recovery.
    const recovering = banner && !(banner as HTMLElement).hidden;
    const now = Date.now();
    if (!recovering && now - last < minIntervalMs) return;
    last = now;
    cb();
  };
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
}

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
