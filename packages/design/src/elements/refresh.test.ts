import { afterEach, describe, expect, it, vi } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import type { CentraidChangeDetail, CentraidHost } from "./host.js";
import {
  debounce,
  observeWidth,
  onDataChange,
  onFocusRefresh,
} from "./refresh.js";

type Listener = (detail: CentraidChangeDetail) => void;

function installFeed(): { emit: Listener; stopped: () => boolean } {
  let listener: Listener | undefined;
  let unsubscribed = false;
  const host: CentraidHost = {
    onChange(cb) {
      listener = cb;
      return () => {
        unsubscribed = true;
      };
    },
  };
  (globalThis as { centraid?: CentraidHost }).centraid = host;
  return {
    emit: (detail) => listener?.(detail),
    stopped: () => unsubscribed,
  };
}

function forgetHost(): void {
  delete (globalThis as { centraid?: CentraidHost }).centraid;
}

describe(debounce, () => {
  it("runs once, on the trailing edge, with the last arguments", () => {
    useFakeClock();
    const seen: number[] = [];
    const bounced = debounce((n: number) => seen.push(n), 50);
    bounced(1);
    bounced(2);
    bounced(3);
    vi.advanceTimersByTime(49);
    expect(seen).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toStrictEqual([3]);
  });
});

describe(onDataChange, () => {
  afterEach(forgetHost);

  it("skips a doorbell that names only tables this app does not read", () => {
    useFakeClock();
    const feed = installFeed();
    const seen: CentraidChangeDetail[] = [];
    const stop = onDataChange(["knowledge.note"], (d) => seen.push(d), {
      debounceMs: 10,
    });
    feed.emit({ tables: ["media.asset"] });
    vi.advanceTimersByTime(10);
    expect(seen).toStrictEqual([]);
    stop();
  });

  it("always fires on an unnamed change — 'this app acted, re-derive'", () => {
    useFakeClock();
    const feed = installFeed();
    const seen: CentraidChangeDetail[] = [];
    const stop = onDataChange(["knowledge.note"], (d) => seen.push(d), {
      debounceMs: 10,
    });
    feed.emit({ tables: [] });
    feed.emit({});
    vi.advanceTimersByTime(10);
    expect(seen).toHaveLength(1);
    stop();
  });

  it("unsubscribes from the feed and drops pending work when stopped", () => {
    useFakeClock();
    const feed = installFeed();
    const seen: CentraidChangeDetail[] = [];
    const stop = onDataChange(null, (d) => seen.push(d), { debounceMs: 10 });
    feed.emit({ tables: ["media.asset"] });
    stop();
    vi.advanceTimersByTime(50);
    expect(seen).toStrictEqual([]);
    expect(feed.stopped()).toBe(true);
  });

  it("is inert on a host with no change feed rather than throwing", () => {
    const stop = onDataChange(["x"], () => {});
    expect(() => stop()).not.toThrow();
  });
});

describe(onFocusRefresh, () => {
  it("gates a focus flurry to one read per interval", () => {
    useFakeClock();
    let reads = 0;
    const stop = onFocusRefresh(() => (reads += 1), { minIntervalMs: 1000 });
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(reads).toBe(1);
    vi.advanceTimersByTime(1000);
    window.dispatchEvent(new Event("focus"));
    expect(reads).toBe(2);
    stop();
    window.dispatchEvent(new Event("focus"));
    expect(reads).toBe(2);
  });

  it("never gates while a consent banner is up — focus IS the recovery path", () => {
    useFakeClock();
    const banner = document.createElement("div");
    banner.id = "consentBanner";
    document.body.appendChild(banner);
    let reads = 0;
    const stop = onFocusRefresh(() => (reads += 1), { minIntervalMs: 60_000 });
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(reads).toBe(2);
    banner.hidden = true;
    window.dispatchEvent(new Event("focus"));
    expect(reads).toBe(2);
    stop();
    banner.remove();
  });
});

describe(observeWidth, () => {
  afterEach(() => {
    delete document.documentElement.dataset.appWidth;
  });

  it("reports immediately and honours the forced-narrow knob over the measure", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", {
      value: 900,
      configurable: true,
    });
    const calls: boolean[] = [];
    const stop = observeWidth(el, 600, (narrow) => calls.push(narrow));
    expect(calls).toStrictEqual([false]);
    stop();

    document.documentElement.dataset.appWidth = "narrow";
    const forced: boolean[] = [];
    const stopForced = observeWidth(el, 600, (narrow) => forced.push(narrow));
    expect(forced).toStrictEqual([true]);
    stopForced();
  });

  it("polls on a visibility gate where ResizeObserver is unavailable", () => {
    useFakeClock();
    const host = globalThis as { ResizeObserver?: typeof ResizeObserver };
    const realRO = host.ResizeObserver;
    delete host.ResizeObserver;
    try {
      const el = document.createElement("div");
      Object.defineProperty(el, "clientWidth", {
        value: 400,
        configurable: true,
      });
      const calls: boolean[] = [];
      const stop = observeWidth(el, 600, (narrow) => calls.push(narrow), {
        pollMs: 100,
      });
      expect(calls).toStrictEqual([true]);
      vi.advanceTimersByTime(100);
      expect(calls).toHaveLength(2);
      stop();
      vi.advanceTimersByTime(500);
      expect(calls).toHaveLength(2);
    } finally {
      host.ResizeObserver = realRO;
    }
  });

  it("measures nothing for a null element, and still returns a stop", () => {
    const calls: boolean[] = [];
    const stop = observeWidth(null, 600, (narrow) => calls.push(narrow));
    expect(calls).toStrictEqual([]);
    expect(() => stop()).not.toThrow();
  });
});
// @vitest-environment jsdom
