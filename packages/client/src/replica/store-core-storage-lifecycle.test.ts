import { describe, expect, test } from "vitest";

import { NodeSqliteDriver } from "./node-sqlite-test-driver.js";
import { ReplicaSqliteStore } from "./store-core.js";
import type { ReplicaBindValue } from "./store-core.js";
import {
  bulkSnapshot,
  searchableSnapshot,
  snapshot,
} from "./store-core.test-fixtures.js";

describe("store-core", () => {
  describe("storage lifecycle", () => {
    class RecordingDriver extends NodeSqliteDriver {
      readonly statements: string[] = [];

      override run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
        this.statements.push(sql);
        super.run(sql, bind);
      }

      override exec(sql: string): void {
        this.statements.push(sql);
        super.exec(sql);
      }
    }

    const optimizeCount = (driver: RecordingDriver): number =>
      driver.statements.filter((sql) => sql.includes("'optimize'")).length;

    test("flips a rebuilt database to incremental auto-vacuum", () => {
      const driver = new RecordingDriver();
      const store = new ReplicaSqliteStore(driver, "vault-a");
      try {
        expect(
          driver.statements.filter((sql) =>
            sql.includes("auto_vacuum=INCREMENTAL")
          )
        ).toHaveLength(1);
        expect(
          driver.all<{ auto_vacuum: number }>("PRAGMA auto_vacuum")[0]
            ?.auto_vacuum
        ).toBe(2);
      } finally {
        store.close();
      }
    });

    test("optimizes the search index at bootstrap commit, not per page", () => {
      const driver = new RecordingDriver();
      const store = new ReplicaSqliteStore(driver, "vault-a");
      try {
        const full = bulkSnapshot(50);
        const header = {
          protocolVersion: full.protocolVersion,
          vaultId: full.vaultId,
          schemaEpoch: full.schemaEpoch,
          shapes: full.shapes,
        };
        store.bootstrapBegin(header);
        store.bootstrapPage(full.rows, {
          after: null,
          commitCursor: full.cursor,
          pages: 1,
        });
        expect(optimizeCount(driver)).toBe(0);

        store.bootstrapCommit(full.cursor);

        expect(optimizeCount(driver)).toBe(1);
        expect(
          store.search({
            shapeId: "shape-photos",
            entity: "core.content_item",
            query: "monsoon",
          }).rows.length
        ).toBeGreaterThan(0);
      } finally {
        store.close();
      }
    });

    test("optimizes once a run of change batches has churned enough of the index", () => {
      const driver = new RecordingDriver();
      const store = new ReplicaSqliteStore(driver, "vault-a");
      try {
        const full = snapshot();
        store.bootstrap({ ...full, rows: [] });
        const before = optimizeCount(driver);
        let cursor = full.cursor;
        for (const [batch, count] of [10_000, 10_001].entries()) {
          const to = { epoch: cursor.epoch, seq: cursor.seq + 1 };
          store.applyChanges({
            protocolVersion: 1,
            schemaEpoch: full.schemaEpoch,
            from: cursor,
            to,
            changes: Array.from({ length: count }, (_, index) => ({
              op: "upsert" as const,
              shapeId: "shape-agenda",
              entity: "core.event",
              rowId: `churn-${batch}-${index}`,
              values: {
                event_id: `churn-${batch}-${index}`,
                title: `Churned ${batch}-${index}`,
                status: "open",
                starts_at: "2026-07-15T10:00:00.000Z",
              },
            })),
          });
          cursor = to;
        }
        expect(optimizeCount(driver) - before).toBe(1);
      } finally {
        store.close();
      }
    }, 20_000);

    test("addresses every search-index delete by rowid rather than scanning", () => {
      const driver = new RecordingDriver();
      const store = new ReplicaSqliteStore(driver, "vault-a");
      try {
        const full = bulkSnapshot(20);
        store.bootstrap(full);
        store.applyChanges({
          protocolVersion: 1,
          schemaEpoch: full.schemaEpoch,
          from: full.cursor,
          to: { epoch: full.cursor.epoch, seq: full.cursor.seq + 1 },
          changes: [
            {
              op: "delete",
              shapeId: "shape-photos",
              entity: "core.content_item",
              rowId: "photo-3",
            },
          ],
        });

        const searchDeletes = driver.statements.filter((sql) =>
          sql.trim().startsWith("DELETE FROM replica_search WHERE")
        );
        expect(searchDeletes.length).toBeGreaterThan(20);
        expect(
          searchDeletes.filter((sql) => !sql.includes("WHERE rowid = "))
        ).toStrictEqual([]);
        expect(
          searchDeletes.filter((sql) =>
            sql.trim().startsWith("DELETE FROM replica_search WHERE shape_id")
          )
        ).toStrictEqual([]);

        const plan = (sql: string, bind: ReplicaBindValue[]): string =>
          driver
            .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, bind)
            .map((step) => step.detail)
            .join(" ");
        const rowidPlan = plan(searchDeletes[0]!, [
          "shape-photos",
          "core.content_item",
          "photo-3",
        ]);
        expect(rowidPlan).toMatch(/VIRTUAL TABLE INDEX \d+:=/u);
        expect(rowidPlan).toMatch(/SEARCH replica_row USING COVERING INDEX/u);
        expect(
          plan(
            `DELETE FROM replica_search
              WHERE shape_id = ? AND entity = ? AND row_id = ?`,
            ["shape-photos", "core.content_item", "photo-3"]
          )
        ).not.toMatch(/VIRTUAL TABLE INDEX \d+:=/u);
      } finally {
        store.close();
      }
    });

    test("rebuilds a replica whose rows predate the search rowid onto version 8", () => {
      const driver = new NodeSqliteDriver();
      driver.exec(`
        CREATE TABLE replica_row (
          shape_id TEXT NOT NULL,
          entity TEXT NOT NULL,
          row_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          oversized_json TEXT NOT NULL,
          server_version INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (shape_id, entity, row_id)
        );
        INSERT INTO replica_row(shape_id, entity, row_id, payload_json, oversized_json)
          VALUES ('shape-photos', 'core.content_item', 'stale', '{}', '[]');
        PRAGMA user_version = 7;
      `);
      const store = new ReplicaSqliteStore(driver, "vault-a");
      try {
        expect(
          driver.all<{ user_version: number }>("PRAGMA user_version")[0]
            ?.user_version
        ).toBe(8);
        expect(
          driver
            .all<{ name: string }>("PRAGMA table_info(replica_row)")
            .map((column) => column.name)
        ).toContain("row_key");
        const full = searchableSnapshot();
        store.bootstrap(full);
        expect(
          store
            .search({
              shapeId: "shape-photos",
              entity: "core.content_item",
              query: "moon",
            })
            .rows.map((row) => row.rowId)
        ).toStrictEqual(["photo-off-window"]);
      } finally {
        store.close();
      }
    });
  });
});
