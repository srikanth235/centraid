/*
 * What an ORDERED replica read costs on a real library (#922 C3).
 *
 * Ordering is `json_extract(payload_json, '$.column')`, which no ordinary
 * index serves, and the order guards used to ride the paging statement as
 * `max(...) OVER ()` window aggregates — so `LIMIT 50` sorted fifty thousand
 * rows to return fifty. The assertions here are on the SHAPE of the plan, not
 * the clock: SQLite's own answer to "did you use an index, and did you sort?"
 */
import { describe, expect, test } from "vitest";

import { ReplicaSqliteStore } from "@centraid/client/replica/native";
import type { ReplicaBindValue } from "@centraid/client/replica/native";

import { NodeSqliteDriver } from "./node-sqlite-driver";

const ROWS = 50_000;
const SHAPE = {
  shapeId: "shape-notes",
  appId: "notes",
  entities: [
    {
      entity: "knowledge.note",
      primaryKey: "note_id",
      columns: ["note_id", "title", "updated_at"],
    },
  ],
};

class RecordingDriver extends NodeSqliteDriver {
  readonly queries: string[] = [];

  override all<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): T[] {
    this.queries.push(sql);
    return super.all<T>(sql, bind);
  }
}

function seeded(): { driver: RecordingDriver; store: ReplicaSqliteStore } {
  const driver = new RecordingDriver();
  const store = new ReplicaSqliteStore(driver, "vault");
  store.bootstrap({
    protocolVersion: 1,
    vaultId: "vault",
    schemaEpoch: "1",
    cursor: { epoch: "epoch", seq: ROWS },
    shapes: [SHAPE],
    rows: Array.from({ length: ROWS }, (_, index) => ({
      shapeId: SHAPE.shapeId,
      entity: "knowledge.note",
      rowId: `note-${index}`,
      values: {
        note_id: `note-${index}`,
        title: `Note ${index}`,
        updated_at: `2026-09-${String((index % 28) + 1).padStart(2, "0")}`,
      },
      rowVersion: index + 1,
    })),
  });
  return { driver, store };
}

const ordered = {
  shapeId: SHAPE.shapeId,
  entity: "knowledge.note",
  orderBy: { column: "updated_at", dir: "desc" as const },
  limit: 50,
};

describe("an ordered read of a fifty-thousand-row library", () => {
  test("pages through an index instead of sorting the entity", () => {
    const { driver, store } = seeded();
    expect(store.read(ordered).rows).toHaveLength(50);
    const paging = driver.queries.findLast((sql) =>
      sql.includes("ORDER BY json_extract")
    );
    expect(paging).toBeDefined();
    const plan = driver
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${paging ?? ""}`, [
        SHAPE.shapeId,
        "knowledge.note",
        51,
      ])
      .map((row) => row.detail);
    expect(
      plan.some((step) => step.includes("USING INDEX replica_row_ord"))
    ).toBe(true);
    // The whole point: no sort of the entity to return a window of it.
    expect(plan.filter((step) => step.includes("TEMP B-TREE"))).toStrictEqual(
      []
    );
    store.close();
  });

  test("the order guards are one statement per write batch, not per read", () => {
    const { driver, store } = seeded();
    const censuses = (): number =>
      driver.queries.filter((sql) => sql.includes("order_straddle")).length;
    store.read(ordered);
    const afterFirst = censuses();
    expect(afterFirst).toBe(1);
    for (let index = 0; index < 25; index += 1) store.read(ordered);
    expect(censuses()).toBe(afterFirst);

    // A write is what makes the answer stale, and only a write.
    store.applyChanges({
      protocolVersion: 1,
      schemaEpoch: "1",
      from: { epoch: "epoch", seq: ROWS },
      to: { epoch: "epoch", seq: ROWS + 1 },
      changes: [
        {
          op: "upsert",
          shapeId: SHAPE.shapeId,
          entity: "knowledge.note",
          rowId: "note-0",
          values: {
            note_id: "note-0",
            title: "Edited",
            updated_at: "2026-09-27",
          },
          rowVersion: ROWS + 1,
        },
      ],
    });
    store.read(ordered);
    expect(censuses()).toBe(afterFirst + 1);
    store.close();
  });

  test("a straddling value still escalates, cache or no cache", () => {
    const { driver, store } = seeded();
    store.read(ordered);
    store.applyChanges({
      protocolVersion: 1,
      schemaEpoch: "1",
      from: { epoch: "epoch", seq: ROWS },
      to: { epoch: "epoch", seq: ROWS + 1 },
      changes: [
        {
          op: "upsert",
          shapeId: SHAPE.shapeId,
          entity: "knowledge.note",
          rowId: "note-1",
          values: { note_id: "note-1", title: "N", updated_at: 20_260_927 },
          rowVersion: ROWS + 1,
        },
      ],
    });
    expect(() => store.read(ordered)).toThrow(/affinity/u);
    void driver;
    store.close();
  });
});
