// TWO OPENERS, ONE SEAT FILE (#1014, P1/C8). The background pass used to open
// a second `SeatWorkerCore` over the file the foreground mount held — which on
// expo-sqlite is the SAME connection object — and its `finally` closed the
// foreground's handle.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

const files = new Map<string, string>();

vi.mock(import("expo-file-system"), () => ({
  File: class FileSeam {
    constructor(readonly uri: string) {}
    get exists(): boolean {
      return files.has(this.uri);
    }
    create(): void {
      files.set(this.uri, "");
    }
    write(text: string): void {
      files.set(this.uri, text);
    }
    textSync(): string {
      return files.get(this.uri) ?? "";
    }
    delete(): void {
      files.delete(this.uri);
    }
  } as unknown as typeof import("expo-file-system").File,
}));

vi.mock(import("../../../modules/centraid-storage"), () => ({
  pathToFileUri: (path: string) => `file://${path}`,
}));

const { acquireSeatLease, seatLeaseHolder } = await import("./seat-lease");

const SEAT = "/doc/CentraidReplica/centraid-seat-abc.sqlite3";

describe("the seat lease", () => {
  beforeEach(() => files.clear());

  it("refuses a second live owner and names who holds it", () => {
    const foreground = acquireSeatLease(SEAT, "foreground");
    expect(foreground).toBeDefined();
    expect(acquireSeatLease(SEAT, "background")).toBeUndefined();
    expect(seatLeaseHolder(SEAT)).toBe("foreground");
    foreground?.release();
    // Once the mount lets go, the headless pass may have it.
    expect(acquireSeatLease(SEAT, "background")).toBeDefined();
  });

  it("lets the same owner re-take its own lease", () => {
    acquireSeatLease(SEAT, "foreground");
    // A relaunch after a kill: the holder is this app, not a rival, and making
    // it wait out its own stale expiry would leave the vault unopenable.
    expect(acquireSeatLease(SEAT, "foreground")).toBeDefined();
  });

  it("expires, so a killed pass never strands the vault", () => {
    const clock = useFakeClock(1_700_000_000_000);
    acquireSeatLease(SEAT, "background", 1_000);
    expect(seatLeaseHolder(SEAT, clock.now() + 2_000)).toBeUndefined();
    clock.set(clock.now() + 2_000);
    expect(acquireSeatLease(SEAT, "foreground")).toBeDefined();
  });

  it("a late release never removes the lease someone else now holds", () => {
    const clock = useFakeClock(1_700_000_000_000);
    const stale = acquireSeatLease(SEAT, "background", 1_000);
    clock.set(clock.now() + 2_000);
    expect(acquireSeatLease(SEAT, "foreground")).toBeDefined();
    // The background pass finally unwinds and lets go of a lease that is no
    // longer its own.
    stale?.release();
    expect(seatLeaseHolder(SEAT)).toBe("foreground");
  });
});
