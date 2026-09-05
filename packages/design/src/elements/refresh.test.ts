// @vitest-environment jsdom
// Refresh discipline: the two wrappers that keep an app from re-reading the
// vault on every doorbell and every alt-tab, plus the width observer. Each one
// exists because the naive version is a performance bug, so the assertions are
// mostly about the reads that must NOT happen.
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

/** Every suite here installs its own host; none may leak into the next. */
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
    // Both collapse onto the "latest" key — one re-derive, not two.
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

  // THE WRITE'S OWN ECHO IS NOT A DOORBELL (#922 D1). The window exists for
  // other people's churn; making the member's own edit the one change that
  // arrives late is the opposite of what it is for.
  it("hands the seat's own overlay detail straight through, with no window", () => {
    useFakeClock();
    const feed = installFeed();
    const seen: CentraidChangeDetail[] = [];
    const stop = onDataChange(["schedule.task"], (d) => seen.push(d), {
      debounceMs: 200,
    });
    feed.emit({
      source: "overlay",
      intentId: "intent-1",
      intentState: "queued",
    });
    expect(seen).toHaveLength(1);
    feed.emit({ source: "overlay", intentId: "intent-1", intentState: "sent" });
    expect(seen.map((d) => d.intentState)).toStrictEqual(["queued", "sent"]);
    vi.advanceTimersByTime(200);
    // Nothing was buffered, so the window has nothing left to fire.
    expect(seen).toHaveLength(2);
    stop();
  });

  it("keeps the window for everything that is not this seat's own write", () => {
    useFakeClock();
    const feed = installFeed();
    const seen: CentraidChangeDetail[] = [];
    const stop = onDataChange(["schedule.task"], (d) => seen.push(d), {
      debounceMs: 200,
    });
    feed.emit({ tables: ["schedule.task"], source: "canonical" });
    feed.emit({ tables: ["schedule.task"], source: "canonical" });
    // A doorbell arriving mid-window must not ride the echo out early.
    feed.emit({ source: "overlay", intentId: "intent-2" });
    expect(seen.map((d) => d.source)).toStrictEqual(["overlay"]);
    vi.advanceTimersByTime(199);
    expect(seen).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(seen.map((d) => d.source)).toStrictEqual(["overlay", "canonical"]);
    stop();
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
    // The absence of the global IS the condition under test, so it is removed
    // through a widened view of `globalThis` rather than suppressed.
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
