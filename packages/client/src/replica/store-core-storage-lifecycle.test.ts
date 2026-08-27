// Storage maintenance the store performs on its own file: the auto-vacuum mode
// a rebuilt database lands in, when the FTS index is merged, that index deletes
// are addressed by rowid rather than scanned, and the destructive migration of a
// replica whose rows predate that rowid. Driver-neutral behaviour lives in
// `store-core.test.ts` and `store-core-bootstrap-walk.test.ts`; these cases need
// a driver that records its statements, so they run on node:sqlite only.
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
    /** Delegating driver that keeps every statement, so PRAGMA/FTS maintenance is assertable. */
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
        // 2 = INCREMENTAL.
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
        // 50 rows is far below the merge interval: a page does not pay for it.
        expect(optimizeCount(driver)).toBe(0);

        store.bootstrapCommit(full.cursor);

        // The cold start wrote the whole index one window at a time.
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
        // `snapshot()`'s agenda shape deliberately: its indexed columns are
        // not in the shape, so every row still rewrites its index entries
        // (which is what the interval counts) without the fixture paying for
        // 21,000 FTS inserts.
        const full = snapshot();
        store.bootstrap({ ...full, rows: [] });
        const before = optimizeCount(driver);
        let cursor = full.cursor;
        // 21 batches of 1,000 rows cross the 20,000-row merge interval once.
        for (let batch = 0; batch < 21; batch += 1) {
          const to = { epoch: cursor.epoch, seq: cursor.seq + 1 };
          store.applyChanges({
            protocolVersion: 1,
            schemaEpoch: full.schemaEpoch,
            from: cursor,
            to,
            changes: Array.from({ length: 1_000 }, (_, index) => ({
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
      // The regression this locks is quadratic, so a wall-clock assertion would
      // be both slow and flaky. Assert the SHAPE instead: what SQL the store
      // issues, and that SQLite resolves it to a lookup. FTS5 leaves
      // `shape_id`/`entity`/`row_id` UNINDEXED, so a delete keyed on that triple
      // rescans the whole index once per row — 125s for a 21,000-row walk.
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
        // One per bootstrapped row plus the delete, and every one of them keyed
        // on the index's own rowid.
        expect(searchDeletes.length).toBeGreaterThan(20);
        expect(
          searchDeletes.filter((sql) => !sql.includes("WHERE rowid = "))
        ).toStrictEqual([]);
        // The store no longer has a statement that can scan the index at all.
        expect(
          searchDeletes.filter((sql) =>
            sql.trim().startsWith("DELETE FROM replica_search WHERE shape_id")
          )
        ).toStrictEqual([]);

        // And SQLite agrees it is a lookup on both sides: FTS5 reports the `=`
        // constraint it accepted in its virtual-table index string, and the
        // rowid the store hands it comes from a covering index on `replica_row`.
        // The old triple-keyed form has no indexed column to key on and leaves
        // the constraint string empty — a full scan of the FTS table per row.
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
      // A v7 replica: `replica_row` keyed by the triple, with no `row_key` to
      // address its index entries by.
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
        // The stale rows went with the old schema, and the rebuilt one indexes.
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
