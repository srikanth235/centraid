// The forward walk: every page applied, the commit pinned to the page-1 cursor
// the convergence replay then starts from, durable intent outcomes reconciled
// against that same cursor, the replay's pass budget, and the page shapes the
// walk refuses outright. Interrupted walks — a mid-pagination 409, a killed
// task resuming, a refused continuation — are `windowed-bootstrap-resume.test.ts`;
// the doubles both suites share are in `windowed-bootstrap.test-fixtures.ts`.
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

  // #922 C5: the walk must not take turns. Page N+1 leaves for the gateway
  // before page N has finished landing, so a cold start costs the LONGER of
  // fetch and apply rather than their sum.
  test("fetches the next page while the current one is applying", async () => {
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
    // What the gateway had been asked for at the moment each page started
    // applying. Serial, page 3's request has not been made when page 2 lands.
    const requestsWhenApplying: number[] = [];
    const applied = target.bootstrapPage.bind(target);
    target.bootstrapPage = async (rows, advance) => {
      requestsWhenApplying.push(requests.length);
      await applied(rows, advance);
    };

    await runWindowedBootstrap({
      gatewayAuth,
      target,
      fetcher,
      window: 1,
      pullChanges: vi.fn<RunWindowedBootstrapOptions["pullChanges"]>(
        async (cursor) => emptyBatch(cursor)
      ),
    });

    expect(target.rows.map((item) => item.rowId)).toStrictEqual([
      "photo-1",
      "photo-2",
      "photo-3",
    ]);
    // Page 2 applies with THREE requests already made — its own and page 3's.
    expect(requestsWhenApplying).toStrictEqual([1, 3, 3]);
    expect(requests).toHaveLength(3);
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
        // A later page reads a LATER snapshot: photo-2 was deleted at seq 11 and
        // simply never appears again. Only the replay from the page-1 cursor can
        // remove the copy page 1 already handed us.
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

    // The crux: committed at page 1's cursor, and the delta pull started there.
    expect(target.committedAt).toStrictEqual({ epoch: "replica-1", seq: 10 });
    expect(pullChanges).toHaveBeenCalledWith(
      { epoch: "replica-1", seq: 10 },
      expect.any(AbortSignal)
    );
    expect(pullChanges.mock.calls[0]?.[0]).toStrictEqual({
      epoch: "replica-1",
      seq: 10,
    });
    // The deletion that slipped between per-page snapshots is repaired.
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
    // A log that always has one more commit: without a budget this never ends.
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
    // Honest: the cursor reached is reported, and the feed continues from it.
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
