import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { beforeAll, describe, expect, test } from "vitest";

import {
  OnlineOnlyError,
  ReplicaProtocolError,
  ReplicaRebootstrapRequiredError,
  ReplicaSearchRefusedError,
} from "./errors.js";
import { NodeSqliteDriver } from "./node-sqlite-test-driver.js";
import { SqliteReplicaStore } from "./sqlite-store.js";
import { ReplicaSqliteStore } from "./store-core.js";
import { searchableSnapshot, snapshot } from "./store-core.test-fixtures.js";
import type { ReplicaChangeBatch } from "./types.js";

let sqlite3: Sqlite3Static;

describe("store-core", () => {
  beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
  });

  type MakeStore = () => ReplicaSqliteStore;

  function runStoreConformance(makeStore: MakeStore): void {
    test("bootstraps a shape and executes a bounded local read", () => {
      const store = makeStore();
      try {
        expect(store.bootstrap(snapshot())).toStrictEqual({
          epoch: "replica-1",
          seq: 2,
        });
        const result = store.read({
          shapeId: "shape-agenda",
          entity: "core.event",
          where: [{ column: "status", op: "eq", value: "open" }],
          orderBy: { column: "starts_at", dir: "desc" },
          limit: 1,
        });
        expect(result.rows.map((row) => row.values.title)).toStrictEqual([
          "Later",
        ]);
        expect(store.status()).toStrictEqual({
          cursor: { epoch: "replica-1", seq: 2 },
          schemaEpoch: "schema-1",
          coverage: "complete",
          durability: "durable",
        });
        expect(store.catalog()).toStrictEqual(snapshot().shapes);
      } finally {
        store.close();
      }
    });

    test("rolls back a whole change batch when any change is invalid", () => {
      const store = makeStore();
      try {
        store.bootstrap(snapshot());
        const batch: ReplicaChangeBatch = {
          protocolVersion: 1,
          schemaEpoch: "schema-1",
          from: { epoch: "replica-1", seq: 2 },
          to: { epoch: "replica-1", seq: 3 },
          changes: [
            {
              op: "upsert",
              shapeId: "shape-agenda",
              entity: "core.event",
              rowId: "event-3",
              values: {
                event_id: "event-3",
                title: "Must roll back",
                status: "open",
                starts_at: "2026-07-15T12:00:00.000Z",
              },
            },
            {
              op: "delete",
              shapeId: "shape-agenda",
              entity: "missing.entity",
              rowId: "missing",
            },
          ],
        };
        expect(() => store.applyChanges(batch)).toThrow(ReplicaProtocolError);
        expect(store.status().cursor).toStrictEqual({
          epoch: "replica-1",
          seq: 2,
        });
        expect(
          store.read({ shapeId: "shape-agenda", entity: "core.event" }).rows
        ).toHaveLength(2);
      } finally {
        store.close();
      }
    });

    test("applies upserts and deletes at one cursor and returns intent outcomes", () => {
      const store = makeStore();
      try {
        store.bootstrap(snapshot());
        const applied = store.applyChanges({
          protocolVersion: 1,
          schemaEpoch: "schema-1",
          from: { epoch: "replica-1", seq: 2 },
          to: { epoch: "replica-1", seq: 3 },
          changes: [
            {
              op: "delete",
              shapeId: "shape-agenda",
              entity: "core.event",
              rowId: "event-1",
            },
            {
              op: "upsert",
              shapeId: "shape-agenda",
              entity: "core.event",
              rowId: "event-2",
              values: {
                event_id: "event-2",
                title: "Canonical update",
                status: "done",
                starts_at: "2026-07-15T10:00:00.000Z",
                body: "small",
              },
            },
          ],
          outcomes: [{ intentId: "intent-1", status: "executed" }],
        });
        expect(applied.cursor).toStrictEqual({ epoch: "replica-1", seq: 3 });
        expect(applied.outcomes).toStrictEqual([
          { intentId: "intent-1", status: "executed" },
        ]);
        expect(
          store
            .read({ shapeId: "shape-agenda", entity: "core.event" })
            .rows.map((row) => row.values.title)
        ).toStrictEqual(["Canonical update"]);
      } finally {
        store.close();
      }
    });

    test("ignores stale row-version changes while still advancing the cursor", () => {
      const store = makeStore();
      try {
        const full = snapshot();
        store.bootstrap({
          ...full,
          rows: full.rows.map((row, index) => ({
            ...row,
            rowVersion: index + 1,
          })),
        });
        store.applyChanges({
          protocolVersion: 1,
          schemaEpoch: "schema-1",
          from: { epoch: "replica-1", seq: 2 },
          to: { epoch: "replica-1", seq: 3 },
          changes: [
            {
              op: "upsert",
              shapeId: "shape-agenda",
              entity: "core.event",
              rowId: "event-1",
              rowVersion: 0,
              values: {
                event_id: "event-1",
                title: "stale",
                status: "open",
                starts_at: "2026-07-15T08:00:00.000Z",
              },
            },
            {
              op: "delete",
              shapeId: "shape-agenda",
              entity: "core.event",
              rowId: "event-2",
              rowVersion: 1,
            },
          ],
        });
        expect(
          store.read({ shapeId: "shape-agenda", entity: "core.event" }).rows
        ).toStrictEqual(
          expect.arrayContaining([
            expect.objectContaining({
              rowId: "event-1",
              rowVersion: 1,
              values: expect.objectContaining({ title: "Earlier" }),
            }),
            expect.objectContaining({ rowId: "event-2", rowVersion: 2 }),
          ])
        );
        expect(store.status().cursor).toStrictEqual({
          epoch: "replica-1",
          seq: 3,
        });
      } finally {
        store.close();
      }
    });

    test("oversized predicates fail online-only instead of returning an incomplete result", () => {
      const store = makeStore();
      try {
        store.bootstrap(snapshot());
        expect(() =>
          store.read({
            shapeId: "shape-agenda",
            entity: "core.event",
            where: [{ column: "body", op: "eq", value: "small" }],
          })
        ).toThrow(OnlineOnlyError);
      } finally {
        store.close();
      }
    });

    test("ranks FTS matches over eager metadata outside the normal read window", () => {
      const store = makeStore();
      try {
        store.bootstrap(searchableSnapshot());
        const result = store.search({
          shapeId: "shape-photos",
          entity: "core.content_item",
          query: "moon camp",
          limit: 10,
        });
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.values).toMatchObject({
          content_id: "photo-off-window",
          title: "Moonlit campsite in Ladakh",
        });
        expect(result.rows[0]?.values._snippet).toContain("⟦Moonlit⟧");
      } finally {
        store.close();
      }
    });

    test("a field-masked entity refuses search instead of reporting no matches", () => {
      const store = makeStore();
      try {
        const full = searchableSnapshot();
        store.bootstrap({
          ...full,
          shapes: full.shapes.map((shape) => ({
            ...shape,
            entities: shape.entities.map((entity) => ({
              ...entity,
              hasUnavailableFields: true,
            })),
          })),
        });
        expect(() =>
          store.search({
            shapeId: "shape-photos",
            entity: "core.content_item",
            query: "moon",
          })
        ).toThrow(ReplicaSearchRefusedError);
      } finally {
        store.close();
      }
    });

    test("keeps FTS search current with incremental replica changes", () => {
      const store = makeStore();
      try {
        store.bootstrap(searchableSnapshot());
        store.applyChanges({
          protocolVersion: 1,
          schemaEpoch: "schema-search",
          from: { epoch: "replica-search", seq: 1 },
          to: { epoch: "replica-search", seq: 2 },
          changes: [
            {
              op: "upsert",
              shapeId: "shape-photos",
              entity: "core.content_item",
              rowId: "photo-off-window",
              values: {
                content_id: "photo-off-window",
                title: "Sunny afternoon",
                deleted_at: null,
                created_at: "2024-01-01T10:00:00.000Z",
              },
            },
          ],
        });
        expect(
          store.search({
            shapeId: "shape-photos",
            entity: "core.content_item",
            query: "moon",
          }).rows
        ).toHaveLength(0);
        expect(
          store.search({
            shapeId: "shape-photos",
            entity: "core.content_item",
            query: "sunny",
          }).rows
        ).toHaveLength(1);
      } finally {
        store.close();
      }
    });

    test("an index churned by upserts and deletes answers like a freshly built one", () => {
      const churned = makeStore();
      const clean = makeStore();
      try {
        const base = searchableSnapshot();
        const renamed = {
          shapeId: "shape-photos",
          entity: "core.content_item",
          rowId: "photo-off-window",
          values: {
            content_id: "photo-off-window",
            title: "Moonlit terrace garden in Ladakh",
            deleted_at: null,
            created_at: "2024-01-01T10:00:00.000Z",
          },
        };
        const added = {
          shapeId: "shape-photos",
          entity: "core.content_item",
          rowId: "photo-added",
          values: {
            content_id: "photo-added",
            title: "Terrace garden after the rain",
            deleted_at: null,
            created_at: "2026-08-01T10:00:00.000Z",
          },
        };
        const kept = {
          shapeId: "shape-photos",
          entity: "core.content_item",
          rowId: "photo-kept",
          values: {
            content_id: "photo-kept",
            title: "Garden gate",
            deleted_at: null,
            created_at: "2026-08-02T10:00:00.000Z",
          },
        };

        churned.bootstrap({ ...base, rows: [...base.rows, kept] });
        churned.applyChanges({
          protocolVersion: 1,
          schemaEpoch: base.schemaEpoch,
          from: base.cursor,
          to: { epoch: base.cursor.epoch, seq: base.cursor.seq + 1 },
          changes: [
            { op: "upsert", ...renamed },
            {
              op: "delete",
              shapeId: "shape-photos",
              entity: "core.content_item",
              rowId: "photo-new",
            },
            { op: "upsert", ...added },
          ],
        });
        clean.bootstrap({ ...base, rows: [renamed, added, kept] });

        const query = { shapeId: "shape-photos", entity: "core.content_item" };
        for (const text of ["garden", "terrace garden", "moon", "gate"]) {
          expect(churned.search({ ...query, query: text }).rows).toStrictEqual(
            clean.search({ ...query, query: text }).rows
          );
        }
        expect(
          churned
            .search({ ...query, query: "garden" })
            .rows.map((row) => row.rowId)
            .sort()
        ).toStrictEqual(["photo-added", "photo-kept", "photo-off-window"]);
        expect(churned.search({ ...query, query: "park" }).rows).toStrictEqual(
          []
        );
      } finally {
        churned.close();
        clean.close();
      }
    });

    test("epoch mismatch wipes canonical state and requires a new snapshot", () => {
      const store = makeStore();
      try {
        store.bootstrap(snapshot());
        expect(() =>
          store.applyChanges({
            protocolVersion: 1,
            schemaEpoch: "schema-1",
            from: { epoch: "replica-2", seq: 0 },
            to: { epoch: "replica-2", seq: 1 },
            changes: [],
          })
        ).toThrow(ReplicaRebootstrapRequiredError);
        expect(store.status()).toStrictEqual({
          cursor: null,
          schemaEpoch: null,
          coverage: "partial",
          durability: "durable",
        });
      } finally {
        store.close();
      }
    });

    test("destructively rebuilds an incompatible v0 replica schema", () => {
      const store = makeStore();
      try {
        expect(store.status()).toStrictEqual({
          cursor: null,
          schemaEpoch: null,
          coverage: "partial",
          durability: "durable",
        });
        expect(store.catalog()).toStrictEqual([]);
        expect(store.bootstrap(snapshot())).toStrictEqual({
          epoch: "replica-1",
          seq: 2,
        });
      } finally {
        store.close();
      }
    });
  }

  describe("ReplicaSqliteStore core (sqlite-wasm driver)", () => {
    runStoreConformance(
      () =>
        new SqliteReplicaStore(new sqlite3.oo1.DB(":memory:", "c"), "vault-a")
    );
  });

  describe("ReplicaSqliteStore core (node:sqlite driver)", () => {
    runStoreConformance(
      () => new ReplicaSqliteStore(new NodeSqliteDriver(), "vault-a")
    );
  });
});
