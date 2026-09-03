import { describe, expect, test, vi } from "vitest";

import { ReplicaProtocolError } from "./errors.js";
import type { IntentOutcome, ReplicaChangeBatch } from "./types.js";
import { runWindowedBootstrap } from "./windowed-bootstrap.js";
import type { RunWindowedBootstrapOptions } from "./windowed-bootstrap.js";
import {
  createFetcher,
  createTarget,
  emptyBatch,
  gatewayAuth,
  row,
  shapes,
} from "./windowed-bootstrap.test-fixtures.js";

describe(runWindowedBootstrap, () => {
  test("walks every page and applies all rows", async () => {
    const target = createTarget();
    const { fetcher, requests } = createFetcher({
      "": {
        protocolVersion: 1,
        vaultId: "vault-a",
        schemaEpoch: "schema-1",
        cursor: { epoch: "replica-1", seq: 10 },
        shapes,
        rows: [row("photo-1")],
        complete: false,
        next: "token-2",
      },
      "token-2": {
        protocolVersion: 1,
        vaultId: "vault-a",
        schemaEpoch: "schema-1",
        cursor: { epoch: "replica-1", seq: 12 },
        rows: [row("photo-2")],
        complete: false,
        next: "token-3",
      },
      "token-3": {
        protocolVersion: 1,
        vaultId: "vault-a",
        schemaEpoch: "schema-1",
        cursor: { epoch: "replica-1", seq: 14 },
        rows: [row("photo-3")],
        complete: true,
      },
    });
    const pullChanges = vi.fn<RunWindowedBootstrapOptions["pullChanges"]>(
      async (cursor) => emptyBatch(cursor)
    );

    await runWindowedBootstrap({
      gatewayAuth,
      target,
      fetcher,
      window: 1,
      pullChanges,
    });

    expect(target.rows.map((item) => item.rowId)).toStrictEqual([
      "photo-1",
      "photo-2",
      "photo-3",
    ]);
    expect(target.header?.shapes).toStrictEqual(shapes);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toContain("window=1");
    expect(requests[1]).toContain("after=token-2");
  });

  test("commits at the page-1 cursor and replays the log from it", async () => {
    const target = createTarget();
    const { fetcher } = createFetcher({
      "": {
        protocolVersion: 1,
        vaultId: "vault-a",
        schemaEpoch: "schema-1",
        cursor: { epoch: "replica-1", seq: 10 },
        shapes,
        rows: [row("photo-1"), row("photo-2")],
        complete: false,
        next: "token-2",
      },
      "token-2": {
        protocolVersion: 1,
        vaultId: "vault-a",
        schemaEpoch: "schema-1",
        cursor: { epoch: "replica-1", seq: 12 },
        rows: [row("photo-3")],
        complete: true,
      },
    });
    const batches: ReplicaChangeBatch[] = [
      {
        protocolVersion: 1,
        schemaEpoch: "schema-1",
        from: { epoch: "replica-1", seq: 10 },
        to: { epoch: "replica-1", seq: 12 },
        changes: [
          {
            op: "delete",
            shapeId: "shape-photos",
            entity: "core.content_item",
            rowId: "photo-2",
          },
        ],
      },
    ];
    const pullChanges = vi.fn<RunWindowedBootstrapOptions["pullChanges"]>(
      async (cursor) => batches.shift() ?? emptyBatch(cursor)
    );

    const cursor = await runWindowedBootstrap({
      gatewayAuth,
      target,
      fetcher,
      window: 2,
      pullChanges,
    });

    expect(target.committedAt).toStrictEqual({ epoch: "replica-1", seq: 10 });
    expect(pullChanges).toHaveBeenCalledWith(
      { epoch: "replica-1", seq: 10 },
      expect.any(AbortSignal)
    );
    expect(pullChanges.mock.calls[0]?.[0]).toStrictEqual({
      epoch: "replica-1",
      seq: 10,
    });
    expect(target.rows.map((item) => item.rowId)).toStrictEqual([
      "photo-1",
      "photo-3",
    ]);
    expect(cursor).toStrictEqual({ epoch: "replica-1", seq: 12 });
  });

  test("reconciles durable intent outcomes against the page-1 cursor", async () => {
    const target = createTarget();
    const { fetcher } = createFetcher({
      "": {
        protocolVersion: 1,
        vaultId: "vault-a",
        schemaEpoch: "schema-1",
        cursor: { epoch: "replica-1", seq: 10 },
        shapes,
        rows: [],
        complete: true,
      },
    });
    const reconcileOutcomes = vi.fn<
      NonNullable<RunWindowedBootstrapOptions["reconcileOutcomes"]>
    >(async () => [
      { intentId: "intent-1", status: "executed" } as IntentOutcome,
    ]);

    await runWindowedBootstrap({
      gatewayAuth,
      target,
      fetcher,
      reconcileOutcomes,
      pullChanges: async (cursor) => emptyBatch(cursor),
    });

    expect(reconcileOutcomes.mock.calls[0]?.[0]).toStrictEqual({
      epoch: "replica-1",
      seq: 10,
    });
    expect(target.committedOutcomes).toStrictEqual([
      { intentId: "intent-1", status: "executed" },
    ]);
  });

  test("surfaces a malformed continuation token as a transport error", async () => {
    const target = createTarget();
    const { fetcher } = createFetcher(
      {
        "": {
          protocolVersion: 1,
          vaultId: "vault-a",
          schemaEpoch: "schema-1",
          cursor: { epoch: "replica-1", seq: 10 },
          shapes,
          rows: [row("photo-1")],
          complete: false,
          next: "token-bad",
        },
        "token-bad": { error: "invalid_replica_bootstrap_token" },
      },
      { "token-bad": 400 }
    );

    await expect(
      runWindowedBootstrap({
        gatewayAuth,
        target,
        fetcher,
        pullChanges: async (cursor) => emptyBatch(cursor),
      })
    ).rejects.toMatchObject({
      code: "invalid_replica_bootstrap_token",
      status: 400,
    });
    expect(target.committedAt).toBeUndefined();
  });

  test("rejects a page whose identity drifts mid-walk", async () => {
    const target = createTarget();
    const { fetcher } = createFetcher({
      "": {
        protocolVersion: 1,
        vaultId: "vault-a",
        schemaEpoch: "schema-1",
        cursor: { epoch: "replica-1", seq: 10 },
        shapes,
        rows: [row("photo-1")],
        complete: false,
        next: "token-2",
      },
      "token-2": {
        protocolVersion: 1,
        vaultId: "vault-a",
        schemaEpoch: "schema-2",
        cursor: { epoch: "replica-1", seq: 12 },
        rows: [],
        complete: true,
      },
    });

    await expect(
      runWindowedBootstrap({
        gatewayAuth,
        target,
        fetcher,
        pullChanges: async (cursor) => emptyBatch(cursor),
      })
    ).rejects.toThrow(ReplicaProtocolError);
    expect(target.committedAt).toBeUndefined();
  });

  test("bounds the convergence replay instead of replaying forever", async () => {
    const target = createTarget();
    const { fetcher } = createFetcher({
      "": {
        protocolVersion: 1,
        vaultId: "vault-a",
        schemaEpoch: "schema-1",
        cursor: { epoch: "replica-1", seq: 10 },
        shapes,
        rows: [],
        complete: true,
      },
    });
    let passes = 0;
    const pullChanges: RunWindowedBootstrapOptions["pullChanges"] = async (
      cursor
    ) => {
      passes += 1;
      return {
        ...emptyBatch(cursor),
        to: { epoch: cursor.epoch, seq: cursor.seq + 1 },
      };
    };

    const cursor = await runWindowedBootstrap({
      gatewayAuth,
      target,
      fetcher,
      pullChanges,
      maxConvergePasses: 5,
    });

    expect(passes, "the budget, not the log, ends the replay").toBe(5);
    expect(cursor).toStrictEqual({ epoch: "replica-1", seq: 15 });
  });

  test("rejects a page that claims completeness and a continuation at once", async () => {
    const target = createTarget();
    const { fetcher } = createFetcher({
      "": {
        protocolVersion: 1,
        vaultId: "vault-a",
        schemaEpoch: "schema-1",
        cursor: { epoch: "replica-1", seq: 10 },
        shapes,
        rows: [],
        complete: true,
        next: "token-2",
      },
    });

    await expect(
      runWindowedBootstrap({
        gatewayAuth,
        target,
        fetcher,
        pullChanges: async (cursor) => emptyBatch(cursor),
      })
    ).rejects.toThrow(ReplicaProtocolError);
  });
});
