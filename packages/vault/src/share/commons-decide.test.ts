import { rmSync } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { decideCommonsIntent } from "./commons-decide.js";
import {
  credential,
  opened,
  roots,
  setup,
} from "./commons-intent.test-fixtures.js";
import { cancelCommonsIntent, queueCommonsIntent } from "./commons.js";

function world() {
  const seats = setup();
  const splits = [
    { party_id: seats.priya.boot.ownerPartyId, share_minor: 500 },
    { party_id: seats.bob.boot.ownerPartyId, share_minor: 500 },
  ];
  const expense = (description: string) => ({
    group_id: seats.groupId,
    description,
    amount_minor: 1000,
    paid_by: seats.bob.boot.ownerPartyId,
    category: "food",
    splits,
  });
  const vaultFor = (vaultId: string) =>
    vaultId === seats.priya.vaultId
      ? seats.priya.db
      : vaultId === seats.bob.vaultId
        ? seats.bob.db
        : vaultId === seats.cara.vaultId
          ? seats.cara.db
          : undefined;
  const queueForBob = (intentId: string, description: string) =>
    queueCommonsIntent({
      seat: seats.bob.db.vault,
      intentId,
      grantId: seats.grant.grantId,
      actorPartyId: seats.bob.boot.ownerPartyId,
      command: "tally.add_expense",
      commandInput: expense(description),
      stewardLabel: "Priya's device",
      now: seats.now,
    });
  const decideAs = (
    who: "priya" | "bob",
    intentId: string,
    decision: "approve" | "decline",
    reason?: string
  ) =>
    decideCommonsIntent({
      steward: seats[who].db,
      stewardVaultId: seats[who].vaultId,
      gateway: seats.gateway,
      credential: credential(seats.priya),
      intentId,
      decision,
      ...(reason ? { reason } : {}),
      vaultFor,
      now: seats.now,
    });
  const statusOf = (intentId: string) =>
    seats.bob.db.vault
      .prepare(
        "SELECT status, reason FROM share_commons_intent WHERE intent_id = ?"
      )
      .get(intentId) as { status: string; reason: string | null } | undefined;
  const receipts = () =>
    seats.priya.db.audit
      .prepare(
        `SELECT action, object_type, object_id, decision, detail_json
           FROM access_receipt WHERE object_type = 'share.commons'
          ORDER BY receipt_id`
      )
      .all() as {
      action: string;
      object_type: string;
      object_id: string;
      decision: string;
      detail_json: string;
    }[];
  return { ...seats, decideAs, queueForBob, statusOf, receipts, vaultFor };
}

describe("issue #872: per-intent steward decision", () => {
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close();
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  test("approving executes the member's command on the steward's rail and settles it executed", () => {
    const seats = world();
    seats.queueForBob("decide-approve", "Ferry tickets");

    const answer = seats.decideAs("priya", "decide-approve", "approve");

    expect(answer).toMatchObject({
      intentId: "decide-approve",
      grantId: seats.grant.grantId,
      decision: "approve",
      decided: true,
      status: "executed",
    });
    expect(answer.reason).toBeUndefined();
    expect(answer.sequence).toBeTypeOf("number");
    expect(seats.statusOf("decide-approve")).toMatchObject({
      status: "executed",
    });
    expect(
      seats.priya.db.vault
        .prepare(
          "SELECT paid_by FROM tally_expense WHERE group_id = ? AND description = ?"
        )
        .get(seats.groupId, "Ferry tickets")
    ).toMatchObject({ paid_by: seats.bob.boot.ownerPartyId });
    expect(
      seats.priya.db.vault
        .prepare(
          `SELECT actor_party_id, outcome FROM share_commons_op
            WHERE grant_id = ? AND command = 'tally.add_expense'
            ORDER BY sequence DESC LIMIT 1`
        )
        .get(seats.grant.grantId)
    ).toMatchObject({
      actor_party_id: seats.bob.boot.ownerPartyId,
      outcome: "executed",
    });
  });

  test("declining settles denied with the steward's own reason and writes nothing to the ledger", () => {
    const seats = world();
    seats.queueForBob("decide-decline", "Private taxi");

    const answer = seats.decideAs(
      "priya",
      "decide-decline",
      "decline",
      "that one is not a group expense"
    );

    expect(answer).toMatchObject({
      decision: "decline",
      decided: true,
      status: "denied",
      reason: "that one is not a group expense",
    });
    expect(seats.statusOf("decide-decline")).toMatchObject({
      status: "denied",
      reason: "that one is not a group expense",
    });
    expect(
      seats.priya.db.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM tally_expense WHERE description = ?"
        )
        .get("Private taxi")
    ).toMatchObject({ n: 0 });
    expect(
      seats.priya.db.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ? AND command = 'tally.add_expense'"
        )
        .get(seats.grant.grantId)
    ).toMatchObject({ n: 0 });
  });

  test("a decline with no words still says something honest", () => {
    const seats = world();
    seats.queueForBob("decide-blank", "Unlabelled");

    const answer = seats.decideAs("priya", "decide-blank", "decline", "   ");

    expect(answer.reason).toBe(
      "the steward declined this request; nothing was applied"
    );
    expect(seats.statusOf("decide-blank")).toMatchObject({ status: "denied" });
  });

  test("a member cannot decide anyone's request, including their own", () => {
    const seats = world();
    seats.queueForBob("decide-not-steward", "Snacks");

    expect(() =>
      seats.decideAs("bob", "decide-not-steward", "approve")
    ).toThrow(/only the commons steward/u);
    expect(seats.statusOf("decide-not-steward")).toMatchObject({
      status: "queued",
    });
  });

  test("the steward cannot decline their own request — that verb is cancel", () => {
    const seats = world();
    queueCommonsIntent({
      seat: seats.priya.db.vault,
      intentId: "decide-self",
      grantId: seats.grant.grantId,
      actorPartyId: seats.priya.boot.ownerPartyId,
      command: "tally.add_expense",
      commandInput: { group_id: seats.groupId },
      now: seats.now,
    });

    expect(() => seats.decideAs("priya", "decide-self", "decline")).toThrow(
      /cancelling it, not by declining it/u
    );
  });

  test("an intent no mounted seat holds is refused by name", () => {
    const seats = world();
    expect(() => seats.decideAs("priya", "no-such-intent", "approve")).toThrow(
      /no-such-intent is not available/u
    );
  });

  test("a decision that arrives after the member cancelled still wins; one that arrives after it executed does not", () => {
    const seats = world();
    seats.queueForBob("decide-race-cancel", "Cancelled then declined");
    cancelCommonsIntent({
      seat: seats.bob.db.vault,
      intentId: "decide-race-cancel",
      now: seats.now,
    });
    expect(seats.statusOf("decide-race-cancel")).toMatchObject({
      status: "cancelled",
    });

    const answered = seats.decideAs(
      "priya",
      "decide-race-cancel",
      "decline",
      "withdrawn, and declined for the record"
    );
    expect(answered).toMatchObject({ decided: true, status: "denied" });

    seats.queueForBob("decide-race-executed", "Already through");
    seats.decideAs("priya", "decide-race-executed", "approve");
    const late = seats.decideAs("priya", "decide-race-executed", "decline");
    expect(late).toMatchObject({
      decided: false,
      status: "executed",
      reason: "this request was already executed",
    });
    expect(seats.statusOf("decide-race-executed")).toMatchObject({
      status: "executed",
    });
  });

  test("every decision leaves a consent receipt on the steward's journal", () => {
    const seats = world();
    seats.queueForBob("decide-receipt-yes", "Approved one");
    seats.queueForBob("decide-receipt-no", "Declined one");

    const before = seats.receipts().length;
    seats.decideAs("priya", "decide-receipt-yes", "approve");
    seats.decideAs("priya", "decide-receipt-no", "decline", "not this time");
    const written = seats.receipts().slice(before);

    expect(written).toHaveLength(2);
    for (const receipt of written) {
      expect(receipt.object_type).toBe("share.commons");
      expect(receipt.object_id).toBe(seats.grant.grantId);
      expect(receipt.action).toBe("decide tally.add_expense");
    }
    expect(written[0]!.decision).toBe("allow");
    expect(JSON.parse(written[0]!.detail_json)).toMatchObject({
      intentId: "decide-receipt-yes",
      decision: "approve",
      actorPartyId: seats.priya.boot.ownerPartyId,
      intentActorPartyId: seats.bob.boot.ownerPartyId,
      applied: true,
    });
    expect(written[1]!.decision).toBe("deny");
    expect(JSON.parse(written[1]!.detail_json)).toMatchObject({
      intentId: "decide-receipt-no",
      decision: "decline",
      applied: true,
      failing: "not this time",
    });
  });
});
