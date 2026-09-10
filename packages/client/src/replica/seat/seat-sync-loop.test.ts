// The coalescing loop's two claims (#996 W5, #1011): a sync in flight absorbs
// the ones behind it and exactly one follow-up runs, and a failure is HANDED
// OVER rather than dropped — the loop still never rejects.

import { describe, expect, it } from "vitest";

import { SeatSyncLoop } from "./seat-sync-loop.js";
import type { SeatWatermark } from "./watermark.js";

const WATERMARK: SeatWatermark = {
  epoch: "epoch-a",
  applied: 3,
  head: 3,
  behind: 0,
  deferredPending: false,
  contents: "full",
};

describe("the seat catch-up coalescer", () => {
  it("absorbs the syncs that arrive behind one in flight", async () => {
    let running = 0;
    let started = 0;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = new SeatSyncLoop({
      sync: async () => {
        started += 1;
        running += 1;
        if (started === 1) await held;
        running -= 1;
        expect(running).toBe(0);
        return WATERMARK;
      },
    });
    const first = loop.sync();
    void loop.sync();
    void loop.sync();
    release();
    await first;
    // Two behind one in flight cost ONE follow-up, not two.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(started).toBe(2);
  });

  it("hands the failure over and still answers undefined", async () => {
    const seen: unknown[] = [];
    const failure = new Error("seat log door answered 403: forbidden");
    const loop = new SeatSyncLoop(
      { sync: () => Promise.reject(failure) },
      { onError: (error) => seen.push(error) }
    );
    // NEVER rejects: a seat that could not reach its gateway is a seat with a
    // slightly older copy, and the host decides what to do about it.
    await expect(loop.sync()).resolves.toBeUndefined();
    expect(seen).toStrictEqual([failure]);
  });
});
