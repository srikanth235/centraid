// The coalescing loop's claims (#996 W5, #1011, #1014): a sync in flight
// absorbs the ones behind it and exactly one follow-up runs; an OUTAGE is
// handed over rather than dropped and answered as `undefined`; and the two
// failures a retry cannot help — out of room, a parked drift — reject, so the
// host's park is reachable instead of being unreachable code (C13, C14).

import { describe, expect, it } from "vitest";

import { SeatBootstrapNoRoomError } from "./seat-bootstrap-no-room-error.js";
import { SeatDriftError } from "./seat-drift-error.js";
import { SeatDriftParkedError } from "./seat-drift-parked-error.js";
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
  // #1014, C13. `native-session.ts`'s "OUT OF ROOM PARKS IT" was unreachable:
  // every failure was swallowed here, so the phone retried a doomed multi-MB
  // download on a five-minute timer forever and nothing ever said why.
  it("rejects for a failure that every retry would repeat", async () => {
    const seen: unknown[] = [];
    const noRoom = new SeatBootstrapNoRoomError(80_000_000, 1_000_000);
    const loop = new SeatSyncLoop(
      { sync: () => Promise.reject(noRoom) },
      { onError: (error) => seen.push(error) }
    );
    await expect(loop.sync()).rejects.toBe(noRoom);
    // Reported AND rethrown: the reason still reaches Diagnostics.
    expect(seen).toStrictEqual([noRoom]);
  });

  it("gives a parked seat no follow-up pass", async () => {
    let started = 0;
    const parked = new SeatDriftParkedError(
      new SeatDriftError("wrong-vault", "artifact is for another vault"),
      3
    );
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = new SeatSyncLoop({
      sync: async () => {
        started += 1;
        await held;
        throw parked;
      },
    });
    const first = loop.sync();
    // Absorbed behind the one in flight — and they must not become the
    // follow-up attempt, which is the loop the park exists to end.
    void loop.sync().catch(() => undefined);
    release();
    await expect(first).rejects.toBe(parked);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(started).toBe(1);
  });
});

describe("a closed loop (#1014, P17)", () => {
  it("never fires the trailing follow-up after close", async () => {
    let started = 0;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = new SeatSyncLoop({
      sync: async () => {
        started += 1;
        await held;
        return WATERMARK;
      },
    });
    const first = loop.sync();
    // A wake frame arrives behind it: without a close this queues one pass.
    void loop.sync();
    // The mount goes: `close()`/`purge()` unlink the file the pass would read.
    loop.close();
    release();
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(1);
  });

  it("answers a later sync with nothing rather than opening the file", async () => {
    let started = 0;
    const loop = new SeatSyncLoop({
      sync: () => {
        started += 1;
        return Promise.resolve(WATERMARK);
      },
    });
    loop.close();
    await expect(loop.sync()).resolves.toBeUndefined();
    expect(started).toBe(0);
  });
});
