import { describe, expect, test } from "vitest";

import { NodeSqliteDriver } from "./node-sqlite-test-driver.js";
import { planReplicaRead } from "./read-plan.js";
import { ReplicaSqliteStore } from "./store-core.js";
import type { ReplicaEntitySchema, ReplicaSnapshot } from "./types.js";

// THE ORDER CENSUS IS A SEEK, NOT A SCAN (#922 C3).
//
// The guards answer "does any kept row hold a value of this class". As one
// aggregate over the kept set that cost a pass over the WHOLE entity, and the
// census cache is dropped on every write — so every ordered read after a write
// paid it again. Each guard is now one seek into the census index, and this
// suite pins BOTH halves: the plan the store executes, and the escalations it
// must still raise.

const SCHEMA: ReplicaEntitySchema = {
  entity: "knowledge.note",
  primaryKey: "note_id",
  columns: ["note_id", "title", "rank"],
  hasUnavailableFields: true,
};

function snapshotOf(
  rows: Array<{ id: string; rank?: unknown; oversized?: boolean }>
): ReplicaSnapshot {
  return {
    protocolVersion: 1,
    vaultId: "vault-a",
    schemaEpoch: "schema-1",
    cursor: { epoch: "replica-1", seq: 1 },
    shapes: [
      {
        shapeId: "shape-notes",
        appId: "notes",
        entities: [SCHEMA],
      },
    ],
    rows: rows.map((row) => ({
      shapeId: "shape-notes",
      entity: "knowledge.note",
      rowId: row.id,
      values: {
        note_id: row.id,
        title: row.id,
        ...(row.oversized || row.rank === undefined ? {} : { rank: row.rank }),
      } as ReplicaSnapshot["rows"][number]["values"],
      ...(row.oversized ? { oversizedFields: ["rank"] } : {}),
    })),
  };
}

function ordered(store: ReplicaSqliteStore): unknown {
  return store.read({
    shapeId: "shape-notes",
    entity: "knowledge.note",
    orderBy: { column: "rank", dir: "asc" },
    limit: 10,
  });
}

function withStore(
  rows: Parameters<typeof snapshotOf>[0],
  body: (store: ReplicaSqliteStore) => void
): void {
  const store = new ReplicaSqliteStore(new NodeSqliteDriver(), "vault-a");
  try {
    store.bootstrap(snapshotOf(rows));
    body(store);
  } finally {
    store.close();
  }
}

describe("order census", () => {
  test("every census access is a seek into the census index", () => {
    const driver = new NodeSqliteDriver();
    const store = new ReplicaSqliteStore(driver, "vault-a");
    try {
      store.bootstrap(
        snapshotOf([
          { id: "a", rank: 1 },
          { id: "b", rank: 2 },
        ])
      );
      // The read creates the indexes the plan needs; the plan is then replayed
      // through EXPLAIN so the assertion is about the statement the store ran.
      ordered(store);
      const plan = planReplicaRead(
        SCHEMA,
        {
          shapeId: "shape-notes",
          entity: "knowledge.note",
          orderBy: { column: "rank", dir: "asc" },
          limit: 10,
        },
        new Date()
      );
      expect(plan.orderCensus).toBeDefined();
      const steps = driver
        .all<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${plan.orderCensus!.sql}`,
          plan.orderCensus!.binds
        )
        .map((step) => step.detail);
      const tableSteps = steps.filter((step) => step.includes("replica_row"));
      expect(tableSteps.length).toBeGreaterThan(0);
      for (const step of tableSteps) {
        expect(step, steps.join(" | ")).toContain("replica_row_cen_");
      }
    } finally {
      store.close();
    }
  });

  // Priority, and the masking a class ladder could have introduced: an absent
  // value must not hide an object, and an object must not hide an oversized
  // field. Each guard asks its OWN question, so none of them can.
  test("an escalating class is raised even when a lower one is present too", () => {
    withStore(
      [
        { id: "a", rank: undefined },
        { id: "b", rank: { nested: true } },
      ],
      (store) => {
        expect(() => ordered(store)).toThrow(
          /undisclosed unavailable field is required for ordering/u
        );
      }
    );
    withStore([{ id: "b", rank: { nested: true } }], (store) => {
      expect(() => ordered(store)).toThrow(/orderBy requires scalar values/u);
    });
    withStore(
      [
        { id: "a", oversized: true },
        { id: "b", rank: { nested: true } },
      ],
      (store) => {
        expect(() => ordered(store)).toThrow(/is required for ordering/u);
      }
    );
  });

  test("a text and a number in the same column straddle; either alone does not", () => {
    withStore(
      [
        { id: "a", rank: 1 },
        { id: "b", rank: "two" },
      ],
      (store) => {
        expect(() => ordered(store)).toThrow(
          /mixed-type comparison requires canonical SQLite affinity/u
        );
      }
    );
    withStore(
      [
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
        { id: "c", rank: null },
      ],
      (store) => {
        expect(() => ordered(store)).not.toThrow();
      }
    );
    withStore(
      [
        { id: "a", rank: "one" },
        { id: "b", rank: "two" },
        { id: "c", rank: null },
      ],
      (store) => {
        expect(() => ordered(store)).not.toThrow();
      }
    );
  });

  test("one write batch costs one census statement, not one per guard", () => {
    const driver = new NodeSqliteDriver();
    const store = new ReplicaSqliteStore(driver, "vault-a");
    const seen: string[] = [];
    const all = driver.all.bind(driver);
    (driver as unknown as { all: unknown }).all = (
      sql: string,
      bind?: readonly unknown[]
    ): unknown => {
      seen.push(sql);
      return all(sql, bind as never);
    };
    try {
      store.bootstrap(
        snapshotOf([
          { id: "a", rank: 1 },
          { id: "b", rank: 2 },
        ])
      );
      ordered(store);
      seen.length = 0;
      // A write drops the census cache; the next ordered read re-asks it.
      store.applyChanges({
        protocolVersion: 1,
        schemaEpoch: "schema-1",
        from: { epoch: "replica-1", seq: 1 },
        to: { epoch: "replica-1", seq: 2 },
        changes: [
          {
            shapeId: "shape-notes",
            entity: "knowledge.note",
            rowId: "c",
            op: "upsert",
            values: { note_id: "c", title: "c", rank: 3 },
          },
        ],
      });
      seen.length = 0;
      ordered(store);
      const censusStatements = seen.filter((sql) =>
        sql.includes("replica_row_cen")
      );
      expect(censusStatements.length).toBeLessThanOrEqual(1);
    } finally {
      store.close();
    }
  });
});
