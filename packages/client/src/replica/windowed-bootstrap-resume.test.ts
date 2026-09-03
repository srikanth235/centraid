import { describe, expect, test, vi } from "vitest";

import { ReplicaRebootstrapRequiredError } from "./errors.js";
import type { ReplicaFetcher } from "./shell-transport.js";
import type { ReplicaCursor } from "./types.js";
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
  test("surfaces a mid-pagination 409 as a rebootstrap so the walk restarts", async () => {
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
          next: "token-2",
        },
        "token-2": {
          error: "replica_rebootstrap_required",
          reason: "schema-changed",
        },
      },
      { "token-2": 409 }
    );

    await expect(
      runWindowedBootstrap({
        gatewayAuth,
        target,
        fetcher,
        pullChanges: async (cursor) => emptyBatch(cursor),
      })
    ).rejects.toThrow(ReplicaRebootstrapRequiredError);
    expect(target.committedAt).toBeUndefined();
  });

  test("resumes a killed walk at the persisted page and still converges", async () => {
    const target = createTarget();
    const pages: Record<string, unknown> = {
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
        cursor: { epoch: "replica-1", seq: 30 },
        rows: [row("photo-3")],
        complete: true,
      },
    };
    const { fetcher, requests } = createFetcher(pages);
    let killAfter: string | undefined = "token-3";
    const killed: ReplicaFetcher = (baseUrl, pathname, init) =>
      killAfter && pathname.includes(`after=${killAfter}`)
        ? Promise.reject(new Error("background task expired"))
        : fetcher(baseUrl, pathname, init);

    await expect(
      runWindowedBootstrap({
        gatewayAuth,
        target,
        fetcher: killed,
        window: 1,
        pullChanges: async (cursor) => emptyBatch(cursor),
      })
    ).rejects.toThrow("background task expired");
    expect(target.committedAt).toBeUndefined();
    expect(target.progress).toStrictEqual({
      schemaEpoch: "schema-1",
      after: "token-3",
      commitCursor: { epoch: "replica-1", seq: 10 },
      pages: 2,
    });

    pages[""] = {
      protocolVersion: 1,
      vaultId: "vault-a",
      schemaEpoch: "schema-1",
      cursor: { epoch: "replica-1", seq: 28 },
      shapes,
      rows: [row("photo-1"), row("photo-4")],
      complete: false,
      next: "token-2",
    };
    killAfter = undefined;
    requests.length = 0;
    const pullChanges = vi.fn<RunWindowedBootstrapOptions["pullChanges"]>(
      async (cursor) => emptyBatch(cursor)
    );

    const cursor = await runWindowedBootstrap({
      gatewayAuth,
      target,
      fetcher: killed,
      window: 1,
      pullChanges,
    });

    expect(
      requests.filter((path) => path.includes("after=token-2"))
    ).toStrictEqual([]);
    expect(requests.some((path) => path.includes("after=token-3"))).toBe(true);
    expect(target.committedAt).toStrictEqual({ epoch: "replica-1", seq: 10 });
    expect(pullChanges.mock.calls[0]?.[0]).toStrictEqual({
      epoch: "replica-1",
      seq: 10,
    });
    expect(cursor).toStrictEqual({ epoch: "replica-1", seq: 10 });
    expect(target.rows.map((item) => item.rowId).sort()).toStrictEqual([
      "photo-1",
      "photo-2",
      "photo-3",
      "photo-4",
    ]);
    expect(target.progress).toBeUndefined();
  });

  test("a committed bootstrap starts the next walk from page one", async () => {
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
        complete: true,
      },
    });
    const options = {
      gatewayAuth,
      target,
      fetcher,
      window: 1,
      pullChanges: async (cursor: ReplicaCursor) => emptyBatch(cursor),
    };

    await runWindowedBootstrap(options);
    expect(target.progress).toBeUndefined();
    requests.length = 0;

    await runWindowedBootstrap(options);

    expect(
      requests.filter((path) => path.includes("after=token-2"))
    ).toHaveLength(1);
    expect(target.committedAt).toStrictEqual({ epoch: "replica-1", seq: 10 });
  });

  test("restarts once when the resumed continuation is refused", async () => {
    const target = createTarget();
    target.progress = {
      schemaEpoch: "schema-1",
      after: "token-stale",
      commitCursor: { epoch: "replica-1", seq: 4 },
      pages: 1,
    };
    const { fetcher, requests } = createFetcher(
      {
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
        "token-stale": {
          error: "replica_rebootstrap_required",
          reason: "snapshot-retention",
        },
        "token-2": {
          protocolVersion: 1,
          vaultId: "vault-a",
          schemaEpoch: "schema-1",
          cursor: { epoch: "replica-1", seq: 12 },
          rows: [row("photo-2")],
          complete: true,
        },
      },
      { "token-stale": 409 }
    );

    const cursor = await runWindowedBootstrap({
      gatewayAuth,
      target,
      fetcher,
      window: 1,
      pullChanges: async (at) => emptyBatch(at),
    });

    expect(
      requests.filter((path) => path.includes("after=token-stale"))
    ).toHaveLength(1);
    expect(target.committedAt).toStrictEqual({ epoch: "replica-1", seq: 10 });
    expect(cursor).toStrictEqual({ epoch: "replica-1", seq: 10 });
    expect(target.rows.map((item) => item.rowId)).toStrictEqual([
      "photo-1",
      "photo-2",
    ]);
  });
});
