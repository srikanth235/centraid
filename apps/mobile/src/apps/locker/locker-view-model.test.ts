// The phone's own derivations (STATES.md's Locker row; SURFACES.md's seats).
//
// What this pins:
//
//  - DENIED, DAY ONE AND LOADING ARE THREE ANSWERS, never one emptiness.
//    Nothing is empty until a read has landed, and a denied read never
//    renders as "nothing is kept here yet".
//  - the precedence order between the seven states, because the order IS the
//    argument and a re-ordering would be invisible in a screenshot
//  - the window's foot says what it knows and never invents a denominator
//  - the three elsewhere-surfaces each carry facts AND a where-sentence, so
//    none of them can become a control with nothing behind it

import { describe, expect, it } from "vitest";

import { WINDOW_RULE } from "@centraid/blueprints/apps/locker/view-copy";

import {
  CUSTODIAN_SEAT_NOTE,
  lockerPendingCount,
  lockerPendingLine,
  lockerScreenState,
  lockerSurfaceCopy,
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
    // Even before the read lands: a refusal is data, not a delay.
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
    // The count is never dressed as a denominator the payload does not carry.
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

describe(lockerSurfaceCopy, () => {
  it("gives each elsewhere-surface facts and a place the act happens", () => {
    for (const key of ["import", "export", "fill"] as const) {
      const copy = lockerSurfaceCopy(key, 42);
      expect(copy.title).not.toBe("");
      expect(copy.lede).not.toBe("");
      expect(copy.facts.length).toBeGreaterThan(0);
      expect(copy.where).not.toBe("");
    }
  });

  it("sends the two custodian surfaces to the desktop and Companion to the extension", () => {
    expect(lockerSurfaceCopy("import").where).toBe(CUSTODIAN_SEAT_NOTE);
    expect(lockerSurfaceCopy("export").where).toBe(CUSTODIAN_SEAT_NOTE);
    expect(lockerSurfaceCopy("fill").where).toContain("browser extension");
  });

  it("counts what an export would put in the clear", () => {
    const facts = lockerSurfaceCopy("export", 42).facts;
    expect(facts[0]?.value).toContain("42 items");
    expect(lockerSurfaceCopy("export", 42).net).toBe(true);
  });
});

// The count says HOW MANY; this says WHAT the first one waits on (#880).
// Locker reads through the gateway's own query handlers, so the device-global
// outbox is the only honest source for the sentence.
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
