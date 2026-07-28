import { afterEach, describe, expect, test } from "vitest";

import { openVaultDb, type VaultDb } from "../db.js";
import { currentReplicaLogState, readReplicaChanges } from "./change-log.js";
import {
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
  type ReplicaInvocationAudit,
} from "./invocation-commits.js";

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
      grantId: null,
      purpose: "dpv:ServiceProvision",
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
});
