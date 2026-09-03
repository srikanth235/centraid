import { describe, expect, it } from "vitest";

import { WINDOW_RULE } from "@centraid/blueprints/apps/locker/view-copy";

import {
  lockerFillCopy,
  lockerPendingCount,
  lockerPendingLine,
  lockerScreenState,
  lockerWindowFoot,
} from "./locker-view-model";
import type { LockerStateInput } from "./locker-view-model";

const settled: LockerStateInput = {
  conflicted: false,
  denied: false,
  loaded: true,
  online: true,
  parked: false,
  pending: 0,
  reauth: false,
  rows: 3,
  stale: false,
};

describe(lockerScreenState, () => {
  it("says nothing when there is nothing to say", () => {
    expect(lockerScreenState(settled)).toBe("ready");
  });

  it("distinguishes a read that has not landed from an empty vault", () => {
    expect(lockerScreenState({ ...settled, loaded: false, rows: 0 })).toBe(
      "loading"
    );
    expect(lockerScreenState({ ...settled, rows: 0 })).toBe("dayone");
  });

  it("never draws day one over a refusal", () => {
    expect(lockerScreenState({ ...settled, denied: true, rows: 0 })).toBe(
      "denied"
    );
    expect(lockerScreenState({ ...settled, denied: true, loaded: false })).toBe(
      "denied"
    );
  });

  it("orders refusal over delay and delay over emptiness", () => {
    expect(lockerScreenState({ ...settled, reauth: true })).toBe("reauth");
    expect(lockerScreenState({ ...settled, conflicted: true })).toBe(
      "conflict"
    );
    expect(lockerScreenState({ ...settled, parked: true })).toBe("parked");
    expect(lockerScreenState({ ...settled, online: false })).toBe("offline");
    expect(lockerScreenState({ ...settled, pending: 2 })).toBe("pending");
    expect(lockerScreenState({ ...settled, stale: true })).toBe("stale");
  });
});

describe(lockerWindowFoot, () => {
  it("draws nothing over a read that has not landed or has no rows", () => {
    expect(lockerWindowFoot(false, 12, false)).toBeNull();
    expect(lockerWindowFoot(true, 0, false)).toBeNull();
  });

  it("states what it is showing rather than inventing a total", () => {
    const truncated = lockerWindowFoot(true, 300, true) ?? "";
    expect(truncated).toContain("300 shown");
    expect(truncated).toContain(WINDOW_RULE);
    expect(truncated).not.toContain("of 3");
    expect(lockerWindowFoot(true, 12, false) ?? "").toContain(
      "12 in the vault"
    );
  });
});

describe(lockerPendingCount, () => {
  it("counts only Locker's own metadata writes", () => {
    expect(
      lockerPendingCount([
        { label: "locker: star-item" },
        { label: "locker: trash-item" },
        { label: "tasks: add-task" },
      ])
    ).toBe(2);
  });
});

describe(lockerFillCopy, () => {
  it("gives Companion facts and a place the act happens", () => {
    const copy = lockerFillCopy();
    expect(copy.title).not.toBe("");
    expect(copy.lede).not.toBe("");
    expect(copy.facts.length).toBeGreaterThan(0);
    expect(copy.where).toContain("browser extension");
  });
});

describe(lockerPendingLine, () => {
  const change = (
    over: Record<string, unknown> = {}
  ): {
    id: string;
    label: string;
    status: string;
    reason?: string;
  } => ({
    id: "intent-1",
    label: "locker: star-item",
    status: "queued",
    ...over,
  });

  it("says nothing when nothing of Locker's is outstanding", () => {
    expect(lockerPendingLine([])).toBeNull();
    expect(
      lockerPendingLine([change({ label: "tasks: add-task" })])
    ).toBeNull();
  });

  it("names the connection a queued metadata write waits on", () => {
    expect(lockerPendingLine([change()])).toBe("Waiting for a connection.");
  });

  it("names the STEWARD a parked write waits on", () => {
    expect(
      lockerPendingLine([
        change({ status: "parked", reason: "Waiting for Ravi." }),
      ])
    ).toBe("Waiting for Ravi.");
  });

  it("skips a status the overlay grammar has no rung for", () => {
    expect(
      lockerPendingLine([
        change({ status: "awaiting-change" }),
        change({ id: "intent-2", status: "sending" }),
      ])
    ).toBe("Sending this change.");
  });
});
