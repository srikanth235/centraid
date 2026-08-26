/**
 * Page-side leak census via `addInitScript` — not a spec file (#842).
 * Install before any document script; Chromium CDP census lives in the spec.
 */

import type { Page } from "@playwright/test";

export interface LeakCensus {
  listeners: number;
  /** `setTimeout` is excluded — it is one-shot. */
  intervals: number;
  eventSources: number;
  observers: number;
  domNodes: number;
  listenersByTarget: Record<string, number>;
}

declare global {
  interface Window {
    __centraidLeak?: {
      census: () => LeakCensus;
    };
  }
}

/** Must run before the shell boots or the first census is already a fiction. */
export async function installLeakProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // WeakMap so a gone target takes its entry — the probe must not be a leak.
    const registry = new WeakMap<EventTarget, Map<string, Set<unknown>>>();
    const intervals = new Set<unknown>();
    const eventSources = new Set<EventSource>();
    const observed = new Set<unknown>();
    // Named targets outlive a route swap; a listener on a removed element dies with it.
    const nameOf = (target: EventTarget): string =>
      target === window
        ? "window"
        : target === document
          ? "document"
          : target === document.body
            ? "body"
            : "other";

    const originalAdd = EventTarget.prototype.addEventListener;
    const originalRemove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function patchedAdd(
      this: EventTarget,
      type: string,
      listener: unknown,
      options?: unknown
    ) {
      if (listener) {
        let byType = registry.get(this);
        if (!byType) {
          byType = new Map();
          registry.set(this, byType);
        }
        const set = byType.get(type) ?? new Set<unknown>();
        set.add(listener);
        byType.set(type, set);
      }
      return originalAdd.call(
        this,
        type,
        listener as EventListener,
        options as AddEventListenerOptions
      );
    } as typeof EventTarget.prototype.addEventListener;
    EventTarget.prototype.removeEventListener = function patchedRemove(
      this: EventTarget,
      type: string,
      listener: unknown,
      options?: unknown
    ) {
      registry.get(this)?.get(type)?.delete(listener);
      return originalRemove.call(
        this,
        type,
        listener as EventListener,
        options as EventListenerOptions
      );
    } as typeof EventTarget.prototype.removeEventListener;

    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    window.setInterval = function patchedSetInterval(
      ...args: Parameters<typeof originalSetInterval>
    ) {
      const handle = originalSetInterval(...args);
      intervals.add(handle);
      return handle;
    } as typeof window.setInterval;
    window.clearInterval = function patchedClearInterval(handle?: unknown) {
      intervals.delete(handle);
      return originalClearInterval(handle as number);
    } as typeof window.clearInterval;

    if (typeof EventSource === "function") {
      const NativeEventSource = EventSource;
      const PatchedEventSource = function PatchedEventSource(
        this: unknown,
        url: string,
        init?: EventSourceInit
      ) {
        const source = new NativeEventSource(url, init);
        eventSources.add(source);
        const nativeClose = source.close.bind(source);
        source.close = () => {
          eventSources.delete(source);
          nativeClose();
        };
        return source;
      } as unknown as typeof EventSource;
      PatchedEventSource.prototype = NativeEventSource.prototype;
      window.EventSource = PatchedEventSource;
    }

    for (const name of [
      "MutationObserver",
      "ResizeObserver",
      "IntersectionObserver",
    ] as const) {
      const ctor = (globalThis as unknown as Record<string, unknown>)[name] as
        | { prototype: { observe: unknown; disconnect: unknown } }
        | undefined;
      if (!ctor) continue;
      const proto = ctor.prototype as {
        observe: (...args: unknown[]) => unknown;
        disconnect: () => unknown;
      };
      const nativeObserve = proto.observe;
      const nativeDisconnect = proto.disconnect;
      proto.observe = function observe(this: object, ...args: unknown[]) {
        observed.add(this);
        return nativeObserve.apply(this, args);
      };
      proto.disconnect = function disconnect(this: object) {
        observed.delete(this);
        return nativeDisconnect.call(this);
      };
    }

    window.__centraidLeak = {
      census: () => {
        const byTarget: Record<string, number> = {
          window: 0,
          document: 0,
          body: 0,
          other: 0,
        };
        let listeners = 0;
        // WeakMap is only enumerable for the three long-lived targets; `other` is a floor.
        for (const target of [
          window,
          document,
          document.body,
        ] as EventTarget[]) {
          const byType = registry.get(target);
          if (!byType) continue;
          let count = 0;
          for (const set of byType.values()) count += set.size;
          byTarget[nameOf(target)] = count;
          listeners += count;
        }
        return {
          listeners,
          intervals: intervals.size,
          eventSources: eventSources.size,
          observers: observed.size,
          domNodes: document.querySelectorAll("*").length,
          listenersByTarget: byTarget,
        };
      },
    };
  });
}

export async function readCensus(page: Page): Promise<LeakCensus> {
  return (await page.evaluate(() => {
    const probe = window.__centraidLeak;
    if (!probe) throw new Error("leak probe not installed on this document");
    return probe.census();
  })) as LeakCensus;
}
