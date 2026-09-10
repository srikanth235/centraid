import { afterEach, describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { currentReplicaLogState, readReplicaChanges } from "./change-log.js";
import {
  expiredOutcomeRecovery,
  pruneReplicaIntentOutcomes,
  replicaDependencyVerdict,
} from "./intent-chain.js";
import {
  REPLICA_IDEMPOTENCY_WINDOW_DAYS,
  deleteReplicaIntentOutcomesForDevice,
  listReplicaIntentOutcomes,
  readReplicaIntentOutcome,
  recordReplicaIntentOutcome,
  recordReplicaIntentOutcomeInTransaction,
  transitionReplicaIntentOutcome,
} from "./intents.js";
import {
  readReplicaInvocationCommit,
  recordReplicaInvocationCommitInTransaction,
} from "./invocation-commits.js";
import type { ReplicaInvocationAudit } from "./invocation-commits.js";

let db: VaultDb | undefined;
describe("intents", () => {
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  const identity = {
    intentId: "intent-1",
    deviceId: "device-1",
    appId: "agenda",
    action: "tasks.add",
    payloadHash: "sha256:0123456789abcdef",
  };

  function auditFor(invocationId: string): ReplicaInvocationAudit {
    return {
      commandName: "test.command",
      agentId: identity.deviceId,
      agentKind: "owner",
      authorityId: null,
      preconditionCount: 0,
      postChecks: [],
      writes: [],
      citations: [],
      provenance: {
        activity: "command.test.command",
        used: { invocation: invocationId },
      },
      receiptDetail: { writes: [], risk: "low" },
    };
  }

  test("intent status transitions are durable and published through replica.intent changes", () => {
    db = openVaultDb();
    recordReplicaIntentOutcome(db.vault, {
      ...identity,
      status: "queued",
      now: new Date("2026-07-15T00:00:00.000Z"),
    });
    transitionReplicaIntentOutcome(db.vault, identity.intentId, {
      status: "parked",
      invocationId: "invocation-1",
      reason: "owner approval required",
      now: new Date("2026-07-15T00:01:00.000Z"),
    });

    expect(
      readReplicaIntentOutcome(db.vault, identity.intentId, identity.deviceId)
    ).toMatchObject({
      ...identity,
      status: "parked",
      invocationId: "invocation-1",
      reason: "owner approval required",
    });
    expect(
      readReplicaIntentOutcome(db.vault, identity.intentId, "another-device")
    ).toBeUndefined();
    expect(
      readReplicaChanges(db.vault).changes.map(({ entity, rowId, op }) => ({
        entity,
        rowId,
        op,
      }))
    ).toStrictEqual([
      { entity: "replica.intent", rowId: "intent-1", op: "insert" },
      // TWO entries for the one status change: the write itself, then the
      // touch trigger's own UPDATE bumping `row_version` (#996, R6). A reader
      // takes the LAST entry's row state, which is why the projector coalesces
      // by (entity, row) rather than counting entries.
      { entity: "replica.intent", rowId: "intent-1", op: "update" },
      { entity: "replica.intent", rowId: "intent-1", op: "update" },
    ]);
  });

  test("intent writes share caller transaction and disappear on rollback", () => {
    db = openVaultDb();
    db.vault.exec("BEGIN");
    recordReplicaIntentOutcomeInTransaction(db.vault, {
      ...identity,
      status: "queued",
    });
    db.vault.exec("ROLLBACK");
    expect(
      readReplicaIntentOutcome(db.vault, identity.intentId, identity.deviceId)
    ).toBeUndefined();
    expect(readReplicaChanges(db.vault).changes).toStrictEqual([]);
  });

  test("intent replay binds immutable identity without persisting arbitrary output", () => {
    db = openVaultDb();
    const vault = db.vault;
    recordReplicaIntentOutcome(vault, { ...identity, status: "executed" });
    expect(() =>
      recordReplicaIntentOutcome(vault, {
        ...identity,
        payloadHash: "sha256:different-payload",
        status: "executed",
      })
    ).toThrow(/different immutable fields/u);
    expect(() =>
      recordReplicaIntentOutcome(vault, { ...identity, status: "failed" })
    ).toThrow(/already terminal/u);
    expect(
      readReplicaIntentOutcome(vault, identity.intentId, identity.deviceId)
    ).not.toHaveProperty("output");
    // node:sqlite hands back null-prototype rows; spreading compares the column
    // data (which is the contract) without asserting the driver's prototype.
    expect({
      ...vault
        .prepare(
          `SELECT count(*) AS n FROM pragma_table_info('replica_intent_outcome') WHERE name = 'output_json'`
        )
        .get(),
    }).toStrictEqual({ n: 0 });
  });

  /*
   * WHAT A TRANSITION MAY NOT ERASE (#1014, G18/B16), and what a recovery
   * read must return (#1014, G19).
   *
   * Red-first on the tree before this: the transition below drops
   * `waitingOn`/`answeredVersions` because the UPDATE binds them
   * unconditionally and only four fields were forwarded, and the list query
   * selected nine of the sixteen columns — so an outcome recovered after a
   * reconnect arrived with no commit position and wedged the seat exactly the
   * way R1 did on the client.
   */
  test("a re-park keeps who it waits on, so a chain park stays re-enterable", () => {
    db = openVaultDb();
    recordReplicaIntentOutcome(db.vault, {
      ...identity,
      status: "parked",
      reason: "waiting for intent-0",
      waitingOn: { seat: "intent", label: "intent-0" },
      answeredVersions: [{ entity: "task", rowId: "task-1", version: 3 }],
    });
    const reparked = transitionReplicaIntentOutcome(
      db.vault,
      identity.intentId,
      { status: "parked", reason: "still waiting for intent-0" }
    );
    expect(reparked?.waitingOn).toStrictEqual({
      seat: "intent",
      label: "intent-0",
    });
    expect(reparked?.answeredVersions).toStrictEqual([
      { entity: "task", rowId: "task-1", version: 3 },
    ]);
  });

  test("a park that settles is waiting on nobody", () => {
    db = openVaultDb();
    recordReplicaIntentOutcome(db.vault, {
      ...identity,
      status: "parked",
      waitingOn: { seat: "owner", label: "Ada" },
    });
    const failed = transitionReplicaIntentOutcome(db.vault, identity.intentId, {
      status: "failed",
      reason: "consent grant revoked while awaiting confirmation",
    });
    expect(failed?.waitingOn).toBeUndefined();
  });

  test("the recovery list returns the whole outcome, commit position included", () => {
    db = openVaultDb();
    recordReplicaIntentOutcome(db.vault, {
      ...identity,
      status: "executed",
      commitSeq: 41,
      answeredVersions: [{ entity: "task", rowId: "task-1", version: 9 }],
      dependsOn: ["intent-0"],
      expiresAt: "2026-10-01T00:00:00.000Z",
    });
    const [recovered] = listReplicaIntentOutcomes(db.vault, identity.deviceId);
    expect(recovered?.commitSeq).toBe(41);
    expect(recovered?.answeredVersions).toStrictEqual([
      { entity: "task", rowId: "task-1", version: 9 },
    ]);
    expect(recovered?.dependsOn).toStrictEqual(["intent-0"]);
    expect(recovered?.expiresAt).toBe("2026-10-01T00:00:00.000Z");
    expect(recovered).toStrictEqual(
      readReplicaIntentOutcome(db.vault, identity.intentId, identity.deviceId)
    );
  });

  test("device recovery cleanup emits deletes but preserves an unfinalized repair marker", () => {
    db = openVaultDb();
    recordReplicaIntentOutcome(db.vault, { ...identity, status: "parked" });
    db.vault.exec("BEGIN");
    recordReplicaInvocationCommitInTransaction(db.vault, {
      invocationId: "invocation-1",
      commandId: "command-1",
      intentId: identity.intentId,
      audit: auditFor("invocation-1"),
      committedAt: "2026-07-15T00:00:00.000Z",
    });
    db.vault.exec("COMMIT");
    recordReplicaIntentOutcome(db.vault, {
      ...identity,
      intentId: "intent-2",
      status: "executed",
    });
    expect(
      listReplicaIntentOutcomes(db.vault, identity.deviceId, {
        status: "parked",
      })
    ).toStrictEqual([
      expect.objectContaining({ intentId: "intent-1", status: "parked" }),
    ]);
    const beforeDelete = currentReplicaLogState(db.vault).watermark;
    expect(
      deleteReplicaIntentOutcomesForDevice(db.vault, identity.deviceId)
    ).toBe(2);
    expect(readReplicaInvocationCommit(db.vault, "invocation-1")).toBeDefined();
    expect(
      listReplicaIntentOutcomes(db.vault, identity.deviceId)
    ).toStrictEqual([]);
    expect(
      readReplicaChanges(db.vault, { since: beforeDelete }).changes
    ).toStrictEqual([
      expect.objectContaining({
        entity: "replica.intent",
        rowId: "intent-1",
        op: "delete",
      }),
      expect.objectContaining({
        entity: "replica.intent",
        rowId: "intent-2",
        op: "delete",
      }),
    ]);
  });

  test("the idempotency window defaults to the retention floor, and expiry is an answer", () => {
    db = openVaultDb();
    const recorded = recordReplicaIntentOutcome(db.vault, {
      ...identity,
      status: "executed",
    });
    // THE WINDOW IS STATED, not left to whatever a sweep happens to do: a
    // client needs to know how long "retry is safe" lasts.
    const days =
      (new Date(recorded.expiresAt!).getTime() -
        new Date(recorded.createdAt).getTime()) /
      86_400_000;
    expect(Math.round(days)).toBe(REPLICA_IDEMPOTENCY_WINDOW_DAYS);
    expect(expiredOutcomeRecovery(db.vault, identity.intentId)).toBeUndefined();
    expect(
      expiredOutcomeRecovery(
        db.vault,
        identity.intentId,
        new Date(new Date(recorded.expiresAt!).getTime() + 1)
      )
    ).toMatchObject({ recovery: "resubmit-as-new-intent" });
  });

  test("a lapsed outcome is held while a seat's cursor is still behind it (OQ-13)", () => {
    db = openVaultDb();
    const lapsed = "2020-01-01T00:00:00.000Z";
    recordReplicaIntentOutcome(db.vault, {
      ...identity,
      status: "executed",
      expiresAt: lapsed,
    });
    db.vault
      .prepare(
        `UPDATE replica_intent_outcome SET commit_seq = 40 WHERE intent_id = ?`
      )
      .run(identity.intentId);

    // The seat has applied up to 30: the outcome answers a projection it has
    // not cleared yet, so pruning it would turn a badge that WOULD have
    // cleared into one that never does.
    expect(
      pruneReplicaIntentOutcomes(db.vault, { holdAtOrAbove: 30 }).pruned
    ).toBe(0);
    expect(
      readReplicaIntentOutcome(db.vault, identity.intentId, identity.deviceId)
    ).toBeDefined();

    // Once the seat is past it, the window's far edge applies.
    expect(
      pruneReplicaIntentOutcomes(db.vault, { holdAtOrAbove: 40 }).pruned
    ).toBe(1);
  });

  test("a predecessor's verdict distinguishes waiting from abandoned", () => {
    db = openVaultDb();
    // Unknown: the create may still be in flight, and waiting resolves it.
    expect(replicaDependencyVerdict(db.vault, ["intent-1"])).toMatchObject({
      kind: "waiting",
      on: "intent-1",
    });
    recordReplicaIntentOutcome(db.vault, { ...identity, status: "sending" });
    expect(replicaDependencyVerdict(db.vault, ["intent-1"])).toMatchObject({
      kind: "waiting",
    });
    recordReplicaIntentOutcome(db.vault, {
      ...identity,
      status: "denied",
      reason: "the vault refused it",
    });
    // Terminal and NOT executed: this dependent will never run, and saying so
    // — with the predecessor's own reason — is the difference between a queue
    // that drains and one that quietly stops.
    expect(replicaDependencyVerdict(db.vault, ["intent-1"])).toStrictEqual({
      kind: "abandoned",
      on: "intent-1",
      reason: "the vault refused it",
    });
    recordReplicaIntentOutcome(db.vault, {
      intentId: "intent-2",
      deviceId: identity.deviceId,
      appId: identity.appId,
      action: identity.action,
      payloadHash: identity.payloadHash,
      status: "executed",
    });
    expect(replicaDependencyVerdict(db.vault, ["intent-2"])).toStrictEqual({
      kind: "ready",
    });
  });
});
