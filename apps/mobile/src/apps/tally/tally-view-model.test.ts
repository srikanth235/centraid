import { describe, expect, it } from "vitest";

import { windowEnd } from "@centraid/blueprints/apps/tally/view-copy";

import { windowFootNoTotal } from "./tally-seat-copy";
import {
  TALLY_CONTRIB_DOORS,
  clockAt,
  findEntry,
  outboxAction,
  outboxIntents,
  tallyHasConflict,
  tallyHasParked,
  tallyPendingCount,
  tallyScreenState,
  tallyWaiting,
  tallyWindowFoot,
} from "./tally-view-model";
import type { TallyStateInput } from "./tally-view-model";

const READY: TallyStateInput = {
  conflicted: false,
  denied: false,
  loaded: true,
  online: true,
  parked: false,
  pending: 0,
  rows: 3,
  stale: false,
};

describe("which state a Tally screen is in", () => {
  it("puts a refusal over everything, including a read that never landed", () => {
    expect(
      tallyScreenState({ ...READY, denied: true, loaded: false, rows: 0 })
    ).toBe("denied");
  });

  it("never calls a set empty before a read has landed", () => {
    expect(tallyScreenState({ ...READY, loaded: false, rows: 0 })).toBe(
      "loading"
    );
  });

  it("orders conflict over parked over offline over pending over stale", () => {
    const busy = {
      ...READY,
      conflicted: true,
      online: false,
      parked: true,
      pending: 2,
      stale: true,
    };
    expect(tallyScreenState(busy)).toBe("conflict");
    expect(tallyScreenState({ ...busy, conflicted: false })).toBe("parked");
    expect(
      tallyScreenState({ ...busy, conflicted: false, parked: false })
    ).toBe("offline");
    expect(
      tallyScreenState({
        ...busy,
        conflicted: false,
        online: true,
        parked: false,
      })
    ).toBe("pending");
    expect(
      tallyScreenState({
        ...busy,
        conflicted: false,
        online: true,
        parked: false,
        pending: 0,
      })
    ).toBe("stale");
  });

  it("offers day one only over a landed, empty read", () => {
    expect(tallyScreenState({ ...READY, rows: 0 })).toBe("dayone");
  });

  it("reaches All settled only with rows, every one of them level", () => {
    expect(tallyScreenState({ ...READY, nets: [0, 0] })).toBe("settled");
    expect(tallyScreenState({ ...READY, nets: [0, 4200] })).toBe("ready");
    expect(tallyScreenState({ ...READY, nets: [] })).toBe("ready");
    expect(tallyScreenState(READY)).toBe("ready");
  });
});

describe("the window's foot", () => {
  it("says nothing before a read lands, or over nothing", () => {
    expect(tallyWindowFoot(false, 60, 194)).toBeNull();
    expect(tallyWindowFoot(true, 0, 0)).toBeNull();
  });

  it("renders §6's sentence where a real total is known", () => {
    expect(tallyWindowFoot(true, 60, 194)).toBe(windowEnd(60, 194));
  });

  it("refuses to invent a denominator where the payload carries none", () => {
    const foot = tallyWindowFoot(true, 60, null);
    expect(foot).toBe(windowFootNoTotal(60));
    expect(foot).not.toMatch(/\d+ of \d+/u);
  });
});

describe("this device's outbox", () => {
  const rows = [
    { id: "i1", label: "tally: add-expense", status: "queued" },
    { id: "i2", label: "tally: settle-up", status: "parked" },
    { id: "i3", label: "locker: star-item", status: "queued" },
    { id: "i4", label: "tally: edit-expense", status: "conflict" },
  ];

  it("counts only Tally's rows, off the label the session composes", () => {
    expect(tallyPendingCount(rows)).toBe(3);
    expect(tallyHasParked(rows)).toBe(true);
    expect(tallyHasConflict(rows)).toBe(true);
    expect(tallyHasParked([rows[2]!])).toBe(false);
  });

  it("recovers the action from the label, and has a word for one without", () => {
    expect(outboxAction("tally: add-expense")).toBe("add-expense");
    expect(outboxAction("nothing")).toBe("");
  });

  it("attributes every row to the member, because this outbox is theirs", () => {
    const intents = outboxIntents(rows, "me");
    expect(intents).toHaveLength(3);
    for (const intent of intents) expect(intent.actorPartyId).toBe("me");
  });

  it("files a parked row of the member's own under in-flight, not Waiting-on-you", () => {
    const sections = tallyWaiting(rows, "me");
    expect(sections.waiting).toHaveLength(0);
    expect(sections.inFlight.map((row) => row.intentId)).toStrictEqual([
      "i1",
      "i2",
    ]);
    expect(sections.total).toBe(3);
  });

  it("never offers a verb this transport cannot fire", () => {
    expect(TALLY_CONTRIB_DOORS.decide).toBe(false);
    const verbs = tallyWaiting(rows, "me").inFlight.flatMap((row) => row.verbs);
    expect(verbs).not.toContain("approve");
    expect(verbs).not.toContain("decline");
  });
});

describe("the small derivations", () => {
  it("reads a wall clock off a stamp, and nothing off a broken one", () => {
    expect(clockAt("not-a-date")).toBeNull();
    expect(clockAt(new Date(2026, 7, 26, 9, 2).toISOString())).toBe("09:02");
  });

  it("finds an entry in whichever loaded ledger holds it", () => {
    const group = [{ expense_id: "a" }];
    const friend = [{ expense_id: "b" }];
    expect(findEntry([group, friend], "b")).toStrictEqual({ expense_id: "b" });
    expect(findEntry([undefined, null, group], "a")).toStrictEqual({
      expense_id: "a",
    });
    expect(findEntry([group, friend], "c")).toBeNull();
  });
});
