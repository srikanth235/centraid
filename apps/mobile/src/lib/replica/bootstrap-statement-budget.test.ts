/*
 * What a bootstrap costs SQLite, per row (#922 C2).
 *
 * A cold start writes every row of the member's replica, so the per-row
 * statement count is the one number that decides how long the first paint
 * waits. It is measured against `node:sqlite` through the same store core the
 * phone and the browser run, with the same statement cache every real driver
 * keeps, so the budget here is the budget a seat pays.
 */
import { describe, expect, test } from "vitest";

import { ReplicaSqliteStore } from "@centraid/client/replica/native";
import type { ReplicaBindValue } from "@centraid/client/replica/native";

import { NodeSqliteDriver } from "./node-sqlite-driver";

const ROWS = 500;

const SHAPE = {
  shapeId: "shape-notes",
  appId: "notes",
  entities: [
    {
      entity: "knowledge.note",
      primaryKey: "note_id",
      columns: ["note_id", "title", "notebook_id", "updated_at"],
    },
  ],
};

/** Counts every statement the store hands SQLite, and every compile. */
class BudgetDriver extends NodeSqliteDriver {
  issued = 0;
  compiled = 0;

  override run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
    this.issued += 1;
    this.count(sql);
    super.run(sql, bind);
  }

  override all<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): T[] {
    this.issued += 1;
    this.count(sql);
    return super.all<T>(sql, bind);
  }

  private readonly seen = new Set<string>();
  private count(sql: string): void {
    if (this.seen.has(sql)) return;
    this.seen.add(sql);
    this.compiled += 1;
  }
}

describe("what a bootstrap costs per row", () => {
  test("no more than three statements a row, and the cache absorbs the rest", () => {
    const driver = new BudgetDriver();
    const store = new ReplicaSqliteStore(driver, "vault");
    const before = driver.issued;
    const beforeCompiled = driver.compiled;
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
          notebook_id: "notebook-1",
          updated_at: "2026-09-01T00:00:00.000Z",
        },
        rowVersion: index + 1,
      })),
    });
    const perRow = (driver.issued - before) / ROWS;
    // ONE: the row upsert. The entity's schema is looked up once for the page
    // rather than once per row, the version guard cannot fire on a snapshot
    // write, and the two search clean-up deletes have nothing to clean. The
    // budget is three; the rest is headroom, not slack to spend unmeasured.
    expect(perRow).toBeLessThanOrEqual(3);
    expect(Math.round(perRow * 100) / 100).toBe(1.01);
    // DISTINCT SQL, not statements issued: the cache compiles each text once,
    // so the compile count must not scale with rows at all.
    expect(driver.compiled - beforeCompiled).toBeLessThan(ROWS);
    store.close();
  });

  test("the replica's sync level is the seat's to declare, and FULL by default", () => {
    const plain = new NodeSqliteDriver();
    const store = new ReplicaSqliteStore(plain, "vault");
    // 2 is FULL, 1 is NORMAL, in SQLite's own numbering.
    expect(
      plain.all<{ synchronous: number }>("PRAGMA synchronous")[0]?.synchronous
    ).toBe(2);
    store.close();

    const relaxed = Object.assign(new NodeSqliteDriver(), {
      synchronous: "NORMAL" as const,
    });
    const relaxedStore = new ReplicaSqliteStore(relaxed, "vault");
    expect(
      relaxed.all<{ synchronous: number }>("PRAGMA synchronous")[0]?.synchronous
    ).toBe(1);
    relaxedStore.close();
  });
});
