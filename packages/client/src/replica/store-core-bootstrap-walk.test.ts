import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { beforeAll, describe, expect, test } from "vitest";

import {
  ReplicaProtocolError,
  ReplicaRebootstrapRequiredError,
} from "./errors.js";
import { NodeSqliteDriver } from "./node-sqlite-test-driver.js";
import { SqliteReplicaStore } from "./sqlite-store.js";
import { ReplicaSqliteStore } from "./store-core.js";
import {
  bulkEventSnapshot,
  bulkSnapshot,
  snapshot,
} from "./store-core.test-fixtures.js";

let sqlite3: Sqlite3Static;

describe("store-core", () => {
  beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
  });

  type MakeStore = () => ReplicaSqliteStore;

  function runBootstrapWalkConformance(makeStore: MakeStore): void {
    test("applies a windowed bootstrap page-wise and reads it after commit", () => {
      const store = makeStore();
      try {
        const full = snapshot();
        const header = {
          protocolVersion: full.protocolVersion,
          vaultId: full.vaultId,
          schemaEpoch: full.schemaEpoch,
          shapes: full.shapes,
        };
        store.bootstrapBegin(header);
        store.bootstrapPage([full.rows[0]!]);
        store.bootstrapPage([full.rows[1]!]);
        expect(store.bootstrapCommit(full.cursor)).toStrictEqual({
          epoch: "replica-1",
          seq: 2,
        });
        expect(store.status()).toStrictEqual({
          cursor: { epoch: "replica-1", seq: 2 },
          schemaEpoch: "schema-1",
          coverage: "complete",
          durability: "durable",
        });
        expect(store.catalog()).toStrictEqual(full.shapes);
        expect(
          store
            .read({ shapeId: "shape-agenda", entity: "core.event" })
            .rows.map((row) => row.rowId)
            .sort()
        ).toStrictEqual(["event-1", "event-2"]);
      } finally {
        store.close();
      }
    });

    test("an uncommitted windowed bootstrap never presents as complete", () => {
      const store = makeStore();
      try {
        const full = snapshot();
        store.bootstrapBegin({
          protocolVersion: full.protocolVersion,
          vaultId: full.vaultId,
          schemaEpoch: full.schemaEpoch,
          shapes: full.shapes,
        });
        store.bootstrapPage([full.rows[0]!]);
        expect(store.status()).toStrictEqual({
          cursor: null,
          schemaEpoch: null,
          coverage: "partial",
          durability: "durable",
        });
        expect(() =>
          store.read({ shapeId: "shape-agenda", entity: "core.event" })
        ).toThrow(ReplicaRebootstrapRequiredError);
      } finally {
        store.close();
      }
    });

    test("reopening a walk that recorded no position discards it", () => {
      const store = makeStore();
      try {
        const full = snapshot();
        const header = {
          protocolVersion: full.protocolVersion,
          vaultId: full.vaultId,
          schemaEpoch: full.schemaEpoch,
          shapes: full.shapes,
        };
        store.bootstrapBegin(header);
        store.bootstrapPage([full.rows[0]!]);
        store.bootstrapBegin(header);
        store.bootstrapPage([full.rows[1]!]);
        store.bootstrapCommit(full.cursor);
        expect(
          store
            .read({ shapeId: "shape-agenda", entity: "core.event" })
            .rows.map((row) => row.rowId)
        ).toStrictEqual(["event-2"]);
      } finally {
        store.close();
      }
    });

    test("reopening a walk that recorded its position resumes it", () => {
      const store = makeStore();
      try {
        const full = snapshot();
        const header = {
          protocolVersion: full.protocolVersion,
          vaultId: full.vaultId,
          schemaEpoch: full.schemaEpoch,
          shapes: full.shapes,
        };
        expect(store.bootstrapBegin(header)).toBeUndefined();
        store.bootstrapPage([full.rows[0]!], {
          after: "token-2",
          commitCursor: full.cursor,
          pages: 1,
        });

        expect(store.bootstrapBegin(header)).toStrictEqual({
          after: "token-2",
          commitCursor: { epoch: "replica-1", seq: 2 },
          pages: 1,
        });
        store.bootstrapPage([full.rows[1]!], {
          after: null,
          commitCursor: { epoch: "replica-1", seq: 9 },
          pages: 2,
        });
        expect(store.bootstrapCommit(full.cursor)).toStrictEqual({
          epoch: "replica-1",
          seq: 2,
        });
        expect(
          store
            .read({ shapeId: "shape-agenda", entity: "core.event" })
            .rows.map((row) => row.rowId)
            .sort()
        ).toStrictEqual(["event-1", "event-2"]);
        expect(store.bootstrapBegin(header)).toBeUndefined();
      } finally {
        store.close();
      }
    });

    test("an explicit restart and a new schema epoch both discard the walk", () => {
      const store = makeStore();
      try {
        const full = snapshot();
        const header = {
          protocolVersion: full.protocolVersion,
          vaultId: full.vaultId,
          schemaEpoch: full.schemaEpoch,
          shapes: full.shapes,
        };
        store.bootstrapBegin(header);
        store.bootstrapPage([full.rows[0]!], {
          after: "token-2",
          commitCursor: full.cursor,
          pages: 1,
        });
        expect(store.bootstrapBegin(header, { restart: true })).toBeUndefined();

        store.bootstrapPage([full.rows[0]!], {
          after: "token-2",
          commitCursor: full.cursor,
          pages: 1,
        });
        expect(
          store.bootstrapBegin({ ...header, schemaEpoch: "schema-2" })
        ).toBeUndefined();
        store.bootstrapPage([full.rows[1]!], {
          after: null,
          commitCursor: full.cursor,
          pages: 1,
        });
        store.bootstrapCommit(full.cursor);
        expect(
          store
            .read({ shapeId: "shape-agenda", entity: "core.event" })
            .rows.map((row) => row.rowId)
        ).toStrictEqual(["event-2"]);
      } finally {
        store.close();
      }
    });

    test("a walk whose shape set changed under it starts over", () => {
      const store = makeStore();
      try {
        const full = snapshot();
        const header = {
          protocolVersion: full.protocolVersion,
          vaultId: full.vaultId,
          schemaEpoch: full.schemaEpoch,
          shapes: full.shapes,
        };
        store.bootstrapBegin(header);
        store.bootstrapPage([full.rows[0]!], {
          after: "token-2",
          commitCursor: full.cursor,
          pages: 1,
        });

        const widened = {
          ...header,
          shapes: [
            ...full.shapes,
            {
              shapeId: "shape-photos",
              appId: "photos",
              purpose: "dpv:ServiceProvision",
              entities: [
                {
                  entity: "core.content_item",
                  primaryKey: "content_id",
                  columns: ["content_id"],
                },
              ],
            },
          ],
        };
        expect(store.bootstrapBegin(widened)).toBeUndefined();
        expect(store.catalog().map((shape) => shape.shapeId)).toStrictEqual([
          "shape-agenda",
          "shape-photos",
        ]);
      } finally {
        store.close();
      }
    });

    test("the partial preview cursor never moves backwards", () => {
      const store = makeStore();
      try {
        const full = snapshot();
        store.bootstrapBegin({
          protocolVersion: full.protocolVersion,
          vaultId: full.vaultId,
          schemaEpoch: full.schemaEpoch,
          shapes: full.shapes,
        });
        store.bootstrapPage([full.rows[0]!]);
        store.bootstrapPreview({ epoch: "replica-1", seq: 40 });
        store.bootstrapPreview({ epoch: "replica-1", seq: 12 });
        expect(store.status().cursor).toStrictEqual({
          epoch: "replica-1",
          seq: 40,
        });
        store.bootstrapPreview({ epoch: "replica-2", seq: 1 });
        expect(store.status().cursor).toStrictEqual({
          epoch: "replica-2",
          seq: 1,
        });
      } finally {
        store.close();
      }
    });

    test("reclaims pages after a purge-sized batch of deletions", () => {
      const store = makeStore();
      try {
        const full = bulkEventSnapshot(1_200);
        store.bootstrap(full);
        const filled = store.storageBytes();
        store.applyChanges({
          protocolVersion: 1,
          schemaEpoch: full.schemaEpoch,
          from: full.cursor,
          to: { epoch: full.cursor.epoch, seq: full.cursor.seq + 1 },
          changes: full.rows.map((row) => ({
            op: "delete" as const,
            shapeId: row.shapeId,
            entity: row.entity,
            rowId: row.rowId,
          })),
        });
        const purged = store.storageBytes();
        expect(purged.pageCount).toBeLessThan(filled.pageCount);
        expect(purged.freePages).toBe(0);
      } finally {
        store.close();
      }
    });

    test("reclaims a purged replica's pages instead of holding the file open", () => {
      const store = makeStore();
      try {
        store.bootstrap(bulkSnapshot(600));
        const filled = store.storageBytes();
        expect(filled.pageCount).toBeGreaterThan(20);
        expect(filled.bytes).toBe(filled.pageCount * filled.pageSize);

        store.wipe();

        const purged = store.storageBytes();
        expect(purged.pageCount).toBeLessThan(filled.pageCount / 2);
        expect(purged.freePages).toBe(0);
        expect(purged.freeBytes).toBe(0);
      } finally {
        store.close();
      }
    });

    test("rejects bootstrap pages and commits outside an open bootstrap", () => {
      const store = makeStore();
      try {
        expect(() => store.bootstrapPage([snapshot().rows[0]!])).toThrow(
          ReplicaProtocolError
        );
        expect(() =>
          store.bootstrapCommit({ epoch: "replica-1", seq: 2 })
        ).toThrow(ReplicaProtocolError);
        store.bootstrap(snapshot());
        expect(() => store.bootstrapPage([snapshot().rows[0]!])).toThrow(
          ReplicaProtocolError
        );
      } finally {
        store.close();
      }
    });

    test("rejects a windowed bootstrap for another vault before any row lands", () => {
      const store = makeStore();
      try {
        const full = snapshot();
        expect(() =>
          store.bootstrapBegin({
            protocolVersion: full.protocolVersion,
            vaultId: "vault-other",
            schemaEpoch: full.schemaEpoch,
            shapes: full.shapes,
          })
        ).toThrow(ReplicaRebootstrapRequiredError);
      } finally {
        store.close();
      }
    });
  }

  describe("ReplicaSqliteStore core (sqlite-wasm driver)", () => {
    runBootstrapWalkConformance(
      () =>
        new SqliteReplicaStore(new sqlite3.oo1.DB(":memory:", "c"), "vault-a")
    );
  });

  describe("ReplicaSqliteStore core (node:sqlite driver)", () => {
    runBootstrapWalkConformance(
      () => new ReplicaSqliteStore(new NodeSqliteDriver(), "vault-a")
    );
  });
});
