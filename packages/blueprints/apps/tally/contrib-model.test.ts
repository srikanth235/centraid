// Waiting's three sections, and the verbs each state actually permits.
//
// The grammar is the outbox's (`_shared/pending-overlay.ts`), and what is
// pinned here is that this app does not widen it: a queued write cannot be
// retried and an expired one cannot be re-sent. Approve and Decline exist now
// — the steward's own answer, through `decideCommonsIntent` — and they are
// drawn ONLY where that door is, with no substitute offered where it is not.
import { describe, expect, it } from "vitest";

import { commandLabel, contribSections, intentTitle } from "./contrib-model.ts";
import type { ContribDoors, Intent } from "./contrib-model.ts";

const ALL_DOORS: ContribDoors = {
  cancel: true,
  retry: true,
  discard: true,
  approvals: true,
  decide: true,
};

const NAMES = new Map([
  ["me", "You"],
  ["ana", "Ana"],
]);

function intent(over: Partial<Intent> & Pick<Intent, "status">): Intent {
  return {
    intentId: `i-${over.status}`,
    actorPartyId: "ana",
    command: "tally.add_expense",
    input: { description: "Beach hut deposit" },
    createdAt: "2026-08-26T09:00:00.000Z",
    ...over,
  };
}

function sections(intents: readonly Intent[], doors = ALL_DOORS) {
  return contribSections({ intents, me: "me", names: NAMES, doors });
}

describe("what a row is called", () => {
  it("never puts the vault's own command name on screen", () => {
    expect(commandLabel("tally.add_expense")).toBe("Add expense");
    expect(commandLabel("settle_up")).toBe("Settle up");
    expect(commandLabel("")).toBe("A change");
  });

  it("names the subject where the intent's input carries one", () => {
    expect(intentTitle(intent({ status: "queued" }))).toBe(
      "Add expense · Beach hut deposit"
    );
    expect(
      intentTitle(
        intent({
          status: "queued",
          command: "tally.add_friend",
          input: { name: "Priya" },
        })
      )
    ).toBe("Add friend · Priya");
    expect(intentTitle(intent({ status: "queued", input: {} }))).toBe(
      "Add expense"
    );
  });
});

describe("which section a row lands in", () => {
  it("puts somebody else's parked act in front of the steward", () => {
    const out = sections([intent({ status: "parked" })]);
    expect(out.waiting).toHaveLength(1);
    expect(out.waiting[0]?.who).toBe("Ana");
    expect(out.waiting[0]?.tone).toBe("seam");
  });

  it("keeps the member's OWN parked write in flight, not waiting on them", () => {
    const out = sections([intent({ status: "parked", actorPartyId: "me" })]);
    expect(out.waiting).toHaveLength(0);
    expect(out.inFlight).toHaveLength(1);
    expect(out.inFlight[0]?.who).toBe("you");
  });

  it("puts queued writes in flight and ended ones at the end", () => {
    const out = sections([
      intent({ status: "queued" }),
      intent({ status: "expired" }),
      intent({ status: "denied" }),
      intent({ status: "cancelled" }),
    ]);
    expect(out.inFlight).toHaveLength(1);
    expect(out.ended).toHaveLength(3);
    expect(out.total).toBe(4);
  });

  it("drops an executed intent entirely — it settled, and the ledger has it", () => {
    expect(sections([intent({ status: "executed" })]).total).toBe(0);
  });

  it("names an actor this vault does not know, rather than guessing", () => {
    const out = sections([intent({ status: "queued", actorPartyId: "zzz" })]);
    expect(out.inFlight[0]?.who).toBe("another member");
  });
});

describe("the verbs each state permits", () => {
  it.each([
    ["queued", ["cancel"]],
    ["parked", ["cancel"]],
    ["denied", ["retry", "discard"]],
    ["expired", ["discard"]],
    ["cancelled", ["discard"]],
  ] as const)("gives the member's own %s write %s", (status, verbs) => {
    const out = sections([intent({ status, actorPartyId: "me" })]);
    const row = [...out.waiting, ...out.inFlight, ...out.ended][0];
    expect(row?.verbs).toStrictEqual(verbs);
  });

  it("gives somebody else's parked act the steward's own answer", () => {
    const out = sections([intent({ status: "parked" })]);
    expect(out.waiting[0]?.verbs).toStrictEqual([
      "approve",
      "decline",
      "approvals",
    ]);
  });

  it("draws NEITHER Approve nor Decline where the decide door is absent", () => {
    // Protocol C1: no fallback behaviour stands in for a door that is not
    // there. The inbox is a different verb, not a substitute for these two.
    const out = sections([intent({ status: "parked" })], {
      cancel: true,
      retry: true,
      discard: true,
      approvals: true,
      decide: false,
    });
    expect(out.waiting[0]?.verbs).toStrictEqual(["approvals"]);
  });

  it("gives the steward the answer even where the host holds no inbox", () => {
    const out = sections([intent({ status: "parked" })], {
      cancel: true,
      retry: true,
      discard: true,
      approvals: false,
      decide: true,
    });
    expect(out.waiting[0]?.verbs).toStrictEqual(["approve", "decline"]);
  });

  it("never offers the steward's answer on the member's OWN parked write", () => {
    const out = sections([intent({ status: "parked", actorPartyId: "me" })]);
    expect(out.inFlight[0]?.verbs).not.toContain("approve");
  });

  it("draws NO control where the host provides no door", () => {
    const out = sections(
      [
        intent({ status: "parked" }),
        intent({ status: "denied", actorPartyId: "me" }),
      ],
      {
        cancel: false,
        retry: false,
        discard: false,
        approvals: false,
        decide: false,
      }
    );
    expect(out.waiting[0]?.verbs).toStrictEqual([]);
    expect(out.ended[0]?.verbs).toStrictEqual([]);
  });

  it("offers a queued write no retry — it has not failed at anything", () => {
    const out = sections([intent({ status: "queued", actorPartyId: "me" })]);
    expect(out.inFlight[0]?.verbs).not.toContain("retry");
  });
});

describe("why a row stopped where it stopped", () => {
  it("prefers the vault's own reason", () => {
    const out = sections([
      intent({ status: "denied", reason: "The group still holds expenses." }),
    ]);
    expect(out.ended[0]?.reason).toBe("The group still holds expenses.");
  });

  it("falls back to the state's own words", () => {
    const out = sections([intent({ status: "queued" })]);
    expect(out.inFlight[0]?.reason).toContain("not in the vault yet");
  });
});
