/**
 * Renderer leak probe (issue #842, W3.5).
 *
 * The shell is a long-lived document: the desktop app and an installed PWA are
 * opened once and left open for days, and every app open is a route swap
 * inside that ONE document (#799 retired the served-app iframe, so nothing is
 * ever torn down by a navigation any more). That makes the four classic
 * renderer leaks product-relevant rather than academic:
 *
 *   detached DOM nodes  — a subtree removed from the document that JS still
 *                         holds, so it survives GC forever
 *   listeners           — `addEventListener` on `window` / `document` that no
 *                         unmount removes
 *   subscriptions       — an `EventSource`, `setInterval`, or observer that
 *                         outlives the component that opened it
 *   caches              — a module-level `Map` that only ever grows
 *
 * This module installs the counters. It is deliberately NOT a spec file: the
 * instrumentation runs inside the page via `addInitScript`, and keeping it
 * beside the assertions would mix two languages of scope in one file.
 *
 * Everything here is standard DOM API wrapping, so the census works on every
 * engine the suite can run (`playwright.config.ts` gates webkit/firefox behind
 * CENTRAID_WEB_CROSS_BROWSER). The Chromium-only half — a post-GC node and
 * heap census over CDP — lives in the spec, because it is a browser capability
 * rather than page instrumentation.
 */

import type { Page } from "@playwright/test";

/** One census of everything the page-side instrumentation tracks. */
export interface LeakCensus {
  /** Live registrations: `addEventListener` calls with no matching removal. */
  listeners: number;
  /** Live `setInterval` handles (`setTimeout` is excluded — it is one-shot). */
  intervals: number;
  /** Open `EventSource` connections — the replica's `_changes` feed and kin. */
  eventSources: number;
  /** Live `Mutation`/`Resize`/`IntersectionObserver` observe() registrations. */
  observers: number;
  /** Elements currently attached to the document. */
  domNodes: number;
  /** Listener registrations broken down by target, for failure attribution. */
  listenersByTarget: Record<string, number>;
}

declare global {
  interface Window {
    __centraidLeak?: {
      census: () => LeakCensus;
    };
  }
}

/**
 * Install the page-side census before any document script runs.
 *
 * Order matters absolutely: a wrapper installed after the shell boots misses
 * every listener the boot registered, so the FIRST census would already be
 * wrong and every delta after it would be measured against a fiction.
 */
export async function installLeakProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Live registrations per target. A WeakMap keyed by the target keeps the
    // probe from being a leak itself: a target that goes away takes its entry
    // with it, exactly as the real listener registry does.
    const registry = new WeakMap<EventTarget, Map<string, Set<unknown>>>();
    const intervals = new Set<unknown>();
    const eventSources = new Set<EventSource>();
    const observed = new Set<unknown>();
    // Only three targets are named; everything else is bucketed. The named
    // ones are the ones that OUTLIVE a route swap — a listener on a removed
    // element dies with it, a listener on `window` does not.
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
        // A duplicate (listener, type, capture) registration is a no-op in the
        // DOM, and a Set models that faithfully.
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
        // Only the three long-lived targets are enumerable from a WeakMap, so
        // the per-target tally is exact for them and the bucket is a floor.
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

/** Read one census out of the page. */
export async function readCensus(page: Page): Promise<LeakCensus> {
  return (await page.evaluate(() => {
    const probe = window.__centraidLeak;
    if (!probe) throw new Error("leak probe not installed on this document");
    return probe.census();
  })) as LeakCensus;
}
