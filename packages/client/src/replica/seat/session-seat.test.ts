// ONE FILE, ONE SEAT, RED FIRST (#996 wave 4).
//
// The seat store landed with exactly one consumer — the shell's watermark line
// — which opened its own `WebSeat` from a React effect. Wave 4 adds a second
// consumer, the read path, and the obvious wiring gives it a second
// `SeatWorkerClient`. That would be two workers, two OPFS access handles and
// TWO APPLIERS on one file: the applier's correctness argument is "one commit,
// one transaction, cursor included", and it is simply false with a second
// writer in the file. The failure is a corrupted seat, not an error.
//
// So the seat belongs to the session, which is already the thing that is
// refcounted per (gateway, vault), and every consumer asks it. These are the
// claims that keep it that way:
//
//   1. two consumers of one session get ONE seat, opened once, even when they
//      ask at the same moment — the race is the interesting case, because a
//      naive memoisation opens twice before either promise settles;
//   2. closing the session closes the seat, once;
//   3. a session with nothing to copy — no vault, no gateway — opens nothing at
//      all rather than opening and discarding;
//   4. a seat is not handed out until the vault has actually arrived in it, and
//      a copy that could not be fetched is "no seat" rather than an empty file.

import { describe, expect, it } from "vitest";

import type { GatewayAuth } from "../../gateway-auth.js";
import { SessionSeat } from "./session-seat.js";
import type { SeatWatermark } from "./watermark.js";
import type { WebSeatOptions } from "./web-seat.js";

const AUTH: GatewayAuth = {
  baseUrl: "https://gateway.test",
  gatewayId: "gw-1",
  vaultId: "vault-1",
  token: "t0ken",
  rememberDevice: true,
};

const CURRENT: SeatWatermark = {
  applied: 900,
  head: 1_204,
  behind: 304,
  deferredPending: false,
  contents: "full",
};

function opener(
  sync: () => Promise<SeatWatermark | undefined> = () =>
    Promise.resolve(CURRENT)
): {
  opened: WebSeatOptions[];
  closed: number;
  syncs: number;
  open: (options: WebSeatOptions) => Promise<{
    sync: () => Promise<SeatWatermark | undefined>;
    close: () => Promise<void>;
    query: <T extends object>() => Promise<T[]>;
  }>;
} {
  const state = {
    opened: [] as WebSeatOptions[],
    closed: 0,
    syncs: 0,
    open: (options: WebSeatOptions) => {
      state.opened.push(options);
      return Promise.resolve({
        sync: () => {
          state.syncs += 1;
          return sync();
        },
        close: () => {
          state.closed += 1;
          return Promise.resolve();
        },
        query: <T extends object>() => Promise.resolve([] as T[]),
      });
    },
  };
  return state;
}

describe("the session's one seat", () => {
  it("does not hand out a seat whose file has not been filled yet", async () => {
    // The file opens on a browser that has never held this vault, and it is
    // EMPTY: no `seat_state`, none of the vault's tables. Handing that out is
    // what put `no such table: schedule_task` on every app screen.
    const host = opener();
    const seat = new SessionSeat(AUTH, host.open);
    const handle = await seat.open();
    expect(handle).toBeDefined();
    expect(host.syncs).toBe(1);
    expect(seat.watermark()).toStrictEqual(CURRENT);
  });

  it("is no seat at all when the copy could not be fetched", async () => {
    const host = opener(() => Promise.reject(new Error("gateway unreachable")));
    const seat = new SessionSeat(AUTH, host.open);
    await expect(seat.open()).resolves.toBeUndefined();
    // The half-open file hands its handles back rather than keeping them: the
    // next open would fight the same OPFS files (#922 E3).
    expect(host.closed).toBe(1);
  });

  it("opens once for two consumers that ask at the same moment", async () => {
    const host = opener();
    const seat = new SessionSeat(AUTH, host.open);
    const [first, second] = await Promise.all([seat.open(), seat.open()]);
    expect(host.opened).toHaveLength(1);
    expect(first).toBe(second);
  });

  it("opens once for two consumers that ask one after the other", async () => {
    const host = opener();
    const seat = new SessionSeat(AUTH, host.open);
    await seat.open();
    await seat.open();
    expect(host.opened).toHaveLength(1);
  });

  it("namespaces the file by gateway and vault, and carries the token", async () => {
    const host = opener();
    await new SessionSeat(AUTH, host.open).open();
    const options = host.opened[0]!;
    expect(options.vaultId).toBe("vault-1");
    expect(options.dbName).toMatch(/^\/centraid-seat-.+\.sqlite3$/u);
    expect(options.headers).toStrictEqual({ Authorization: "Bearer t0ken" });
    expect(options.remember).toBe(true);
  });

  it("opens nothing at all when there is no vault to copy", async () => {
    const host = opener();
    const seat = new SessionSeat(
      { baseUrl: "https://gateway.test" },
      host.open
    );
    await expect(seat.open()).resolves.toBeUndefined();
    expect(host.opened).toStrictEqual([]);
    expect(seat.watermark()).toBeUndefined();
  });

  it("reports the watermark the seat reached, and undefined before it has", async () => {
    const host = opener();
    const seat = new SessionSeat(AUTH, host.open);
    expect(seat.watermark()).toBeUndefined();
    await seat.sync();
    expect(seat.watermark()).toStrictEqual(CURRENT);
  });

  it("stays quiet when the seat cannot open — an older copy is not an error", async () => {
    const seat = new SessionSeat(AUTH, () =>
      Promise.reject(new Error("this browser has no OPFS"))
    );
    await expect(seat.open()).resolves.toBeUndefined();
    expect(seat.watermark()).toBeUndefined();
  });

  it("closes the seat it opened, exactly once", async () => {
    const host = opener();
    const seat = new SessionSeat(AUTH, host.open);
    await seat.open();
    await seat.close();
    await seat.close();
    expect(host.closed).toBe(1);
  });

  it("does not reopen after close — a closed session has no seat", async () => {
    const host = opener();
    const seat = new SessionSeat(AUTH, host.open);
    await seat.open();
    await seat.close();
    await expect(seat.open()).resolves.toBeUndefined();
    expect(host.opened).toHaveLength(1);
  });
});
