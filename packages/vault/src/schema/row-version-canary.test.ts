/*
 * THE COVERAGE CANARY FOR `row_version` (#1014, G8/G11).
 *
 * The optimistic-concurrency guard is one column and one trigger, and both
 * were per-table opt-in with nothing checking who had opted in. Every ext
 * physical had neither, so two members editing one row of a third-party app's
 * own table silently overwrote each other; the register in `updated-at.ts`
 * holds what is still uncovered.
 *
 * Both directions are asserted, which is what makes this a tripwire rather
 * than a list: a new replicated table cannot arrive without the column unless
 * someone writes its name into the register, and a register entry cannot
 * survive the column being added.
 */
import { DatabaseSync } from "node:sqlite";

import { beforeAll, describe, expect, test } from "vitest";

import type { VaultDb } from "../db.js";
import { applyExtBand } from "../gateway/ext.js";
import { migrateVault } from "./migrate.js";
import { replicatedTablesOf } from "./private-tables.js";
import { REPLICA_ROW_VERSION_GAP } from "./updated-at.js";

function open(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrateVault(db);
  return db;
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
  ).map((column) => column.name);
}

describe("every replicated table's version column", () => {
  let db: DatabaseSync;
  let tables: string[];

  beforeAll(() => {
    db = open();
    tables = replicatedTablesOf(db);
  });

  test("carries `row_version` or is named in the register", () => {
    const uncovered = tables.filter(
      (table) => !columnsOf(db, table).includes("row_version")
    );
    expect([...uncovered].sort()).toStrictEqual(
      [...REPLICA_ROW_VERSION_GAP].sort()
    );
  });

  test("the register names nothing that already has the column", () => {
    const stale = REPLICA_ROW_VERSION_GAP.filter(
      (table) =>
        tables.includes(table) && columnsOf(db, table).includes("row_version")
    );
    expect(stale).toStrictEqual([]);
  });
});

describe("an ext table's version column", () => {
  const spec = {
    name: "workout",
    columns: [
      { name: "workout_id", type: "text" as const, primaryKey: true },
      { name: "note", type: "text" as const },
    ],
  };

  function withExtBand(): DatabaseSync {
    const db = open();
    applyExtBand({ vault: db } as unknown as VaultDb, "gym", [spec], "live");
    return db;
  }

  test("a freshly created ext physical carries it", () => {
    const db = withExtBand();
    expect(columnsOf(db, "ext_gym_workout")).toContain("row_version");
  });

  test("an ordinary update bumps it, so a seat has a base to state", () => {
    const db = withExtBand();
    db.prepare(
      `INSERT INTO ext_gym_workout (workout_id, note) VALUES ('w1', 'first')`
    ).run();
    const before = db
      .prepare(
        `SELECT row_version AS v FROM ext_gym_workout WHERE workout_id = 'w1'`
      )
      .get() as { v: number };
    expect(before.v).toBe(1);
    db.prepare(
      `UPDATE ext_gym_workout SET note = 'second' WHERE workout_id = 'w1'`
    ).run();
    const after = db
      .prepare(
        `SELECT row_version AS v FROM ext_gym_workout WHERE workout_id = 'w1'`
      )
      .get() as { v: number };
    expect(after.v).toBe(2);
  });

  test("an app may not declare a column that shadows it", () => {
    const db = open();
    expect(() =>
      applyExtBand(
        { vault: db } as unknown as VaultDb,
        "gym",
        [
          {
            name: "workout",
            columns: [
              { name: "workout_id", type: "text" as const, primaryKey: true },
              { name: "row_version", type: "integer" as const },
            ],
          },
        ],
        "live"
      )
    ).toThrow(/reserved by the replication guard/u);
  });

  test("a file whose ext physical predates the guard gains it on open", () => {
    const db = open();
    // The shape #1014 found in the field: a registered ext physical with no
    // version column and no trigger, exactly as `extTableDdl` used to build it.
    db.exec(
      `CREATE TABLE ext_gym_legacy (legacy_id TEXT PRIMARY KEY, note TEXT) STRICT`
    );
    db.prepare(
      `INSERT INTO access_app_ext
         (app_id, band, table_name, physical, spec_json, status, created_at, updated_at)
       VALUES ('gym', 'live', 'legacy', 'ext_gym_legacy', '{}', 'active', '2026-01-01', '2026-01-01')`
    ).run();
    expect(columnsOf(db, "ext_gym_legacy")).not.toContain("row_version");

    migrateVault(db);

    expect(columnsOf(db, "ext_gym_legacy")).toContain("row_version");
    db.prepare(
      `INSERT INTO ext_gym_legacy (legacy_id, note) VALUES ('w2', 'first')`
    ).run();
    db.prepare(
      `UPDATE ext_gym_legacy SET note = 'second' WHERE legacy_id = 'w2'`
    ).run();
    expect(
      (
        db
          .prepare(
            `SELECT row_version AS v FROM ext_gym_legacy WHERE legacy_id = 'w2'`
          )
          .get() as { v: number }
      ).v
    ).toBe(2);
  });
});
