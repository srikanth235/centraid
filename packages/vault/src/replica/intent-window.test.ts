/*
 * WHAT SURVIVES THE IDEMPOTENCY WINDOW, AND WHO THE WINDOW BELONGS TO
 * (#1014, G16/G17/G23/V9).
 *
 * Three separate ways an already-executed intent could run a second time:
 *   - the prune DELETED the outcome, and `expiredOutcomeRecovery` answers
 *     `undefined` for a row that is gone — so pruning was the way to defeat
 *     the dedupe check;
 *   - the prune's seat hold skipped every row with no `commit_seq`, which is
 *     every `parked` outcome, so a confirmation the owner had not decided yet
 *     was deleted out from under them;
 *   - identity was keyed on the ENROLMENT while the durable outbox lives in
 *     the seat file, so a restored phone under a new endpoint id was a dedupe
 *     miss on every intent it replayed.
 */
import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import {
  expiredOutcomeRecovery,
  pruneReplicaIntentOutcomes,
  REPLICA_INTENT_TOMBSTONE_REASON,
} from "./intent-chain.js";
import {
  readReplicaIntentOutcome,
  readReplicaIntentOutcomeForSeat,
  recordReplicaIntentOutcome,
} from "./intents.js";

const LAPSED = "2020-01-01T00:00:00.000Z";

const identity = {
  intentId: "intent-1",
  deviceId: "device-a",
  appId: "photos",
  action: "update-asset",
  payloadHash: "a".repeat(64),
};

function open(): VaultDb {
  return openVaultDb();
}

describe("a lapsed outcome", () => {
  test("becomes a tombstone, so its id can never run twice", () => {
    const db = open();
    recordReplicaIntentOutcome(db.vault, {
      ...identity,
      status: "executed",
      reason: "done",
      expiresAt: LAPSED,
    });
    db.vault
      .prepare(
        `UPDATE replica_intent_outcome
            SET produced_json = '[{"table":"media_asset","pk":["a1"]}]',
                commit_seq = 7
          WHERE intent_id = ?`
      )
      .run(identity.intentId);

    expect(
      pruneReplicaIntentOutcomes(db.vault, { holdAtOrAbove: 9 }).pruned
    ).toBe(1);

    const left = readReplicaIntentOutcome(
      db.vault,
      identity.intentId,
      identity.deviceId
    );
    // The id, the device, the app, the action and the hash stay; the payload,
    // the produced set and the reason go.
    expect(left).toMatchObject({
      intentId: identity.intentId,
      payloadHash: identity.payloadHash,
      reason: REPLICA_INTENT_TOMBSTONE_REASON,
    });
    expect(left?.produced).toBeUndefined();
    // THE POINT: the row is still there, so the door still answers
    // "I no longer know" instead of executing the intent again.
    expect(expiredOutcomeRecovery(db.vault, identity.intentId)).toMatchObject({
      recovery: "resubmit-as-new-intent",
    });
    db.close();
  });

  test("collapsing is idempotent — a second sweep changes nothing", () => {
    const db = open();
    recordReplicaIntentOutcome(db.vault, {
      ...identity,
      status: "denied",
      reason: "no",
      expiresAt: LAPSED,
    });
    expect(pruneReplicaIntentOutcomes(db.vault).pruned).toBe(1);
    expect(pruneReplicaIntentOutcomes(db.vault).pruned).toBe(0);
    db.close();
  });
});

describe("an outcome that is still waiting", () => {
  test("a parked confirmation is never collapsed, hold or no hold", () => {
    const db = open();
    recordReplicaIntentOutcome(db.vault, {
      ...identity,
      status: "parked",
      reason: "waiting for Ada to confirm",
      waitingOn: { seat: "owner", label: "Ada" },
      expiresAt: LAPSED,
    });
    // No `commit_seq` — which is exactly the row the old predicate deleted
    // regardless of the seat's position.
    expect(pruneReplicaIntentOutcomes(db.vault).pruned).toBe(0);
    expect(
      pruneReplicaIntentOutcomes(db.vault, { holdAtOrAbove: 1_000 }).pruned
    ).toBe(0);
    expect(
      readReplicaIntentOutcome(db.vault, identity.intentId, identity.deviceId)
    ).toMatchObject({ status: "parked", reason: "waiting for Ada to confirm" });
    db.close();
  });

  test("a seat that has not reached the commit still holds it", () => {
    const db = open();
    recordReplicaIntentOutcome(db.vault, {
      ...identity,
      status: "executed",
      reason: "done",
      expiresAt: LAPSED,
    });
    db.vault
      .prepare(
        `UPDATE replica_intent_outcome SET commit_seq = 40 WHERE intent_id = ?`
      )
      .run(identity.intentId);
    expect(
      pruneReplicaIntentOutcomes(db.vault, { holdAtOrAbove: 30 }).pruned
    ).toBe(0);
    db.close();
  });
});

describe("a seat that came back under a new enrolment", () => {
  test("its own already-executed intent is a dedupe hit, not a refusal", () => {
    const db = open();
    recordReplicaIntentOutcome(db.vault, { ...identity, status: "executed" });
    // The restored phone: same seat file, same outbox, same intent id and
    // payload — a brand-new endpoint id.
    expect(
      readReplicaIntentOutcomeForSeat(db.vault, identity.intentId, {
        deviceId: "device-restored",
        payloadHash: identity.payloadHash,
      })
    ).toMatchObject({ status: "executed" });
    // And recording against it no longer throws `intent_id_reused`.
    expect(
      recordReplicaIntentOutcome(db.vault, {
        ...identity,
        deviceId: "device-restored",
        status: "executed",
      }).intentId
    ).toBe(identity.intentId);
    db.close();
  });

  test("a different payload under a known id is still a reuse", () => {
    const db = open();
    recordReplicaIntentOutcome(db.vault, { ...identity, status: "executed" });
    expect(
      readReplicaIntentOutcomeForSeat(db.vault, identity.intentId, {
        deviceId: "device-restored",
        payloadHash: "b".repeat(64),
      })
    ).toBeUndefined();
    expect(() =>
      recordReplicaIntentOutcome(db.vault, {
        ...identity,
        deviceId: "device-restored",
        payloadHash: "b".repeat(64),
        status: "executed",
      })
    ).toThrow(/replayed with different immutable fields/u);
    db.close();
  });
});
