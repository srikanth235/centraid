// A vault.db built from the BASELINE DDL alone, for the tests that assert what
// a fresh file IS (#916).
//
// Every shape rung eleven settles lives in the baseline DDL modules rather
// than in a migration rung: v0 has no files in the field to walk forward, so a
// ladder of rungs that reconstruct a shape the baseline could simply state is
// compatibility code for a compatibility problem nobody has. These helpers
// open the composed baseline and nothing else, so a test that says "a fresh
// vault refuses X" is reading the module that decides it.

import { DatabaseSync } from "node:sqlite";

import { refreshEntityTriggers } from "./entity.js";
import { registerContentTextFn } from "./fts.js";
import { VAULT_MIGRATIONS } from "./migrate.js";

/**
 * An in-memory vault.db carrying the composed baseline, its entity-membership
 * triggers and `PRAGMA foreign_keys = ON` — the three things that make the
 * engine, rather than a caller, the thing under test.
 *
 * The replica's generated triggers are deliberately NOT installed: they log
 * every write to `replica_change`, which is noise for a shape assertion, and
 * the suites that care about them install them themselves.
 */
export const BASELINE_NOW = "2026-09-02T10:00:00.000Z";

export function baselineVault(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  registerContentTextFn(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(VAULT_MIGRATIONS[0] ?? "");
  refreshEntityTriggers(db);
  return db;
}

/** The `CREATE TABLE` text a fresh file holds for one table. */
export function tableSql(db: DatabaseSync, table: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string } | undefined;
  if (row === undefined) throw new Error(`no such table: ${table}`);
  return row.sql;
}

/** Column names of `table`, in declaration order. */
export function columnsOf(db: DatabaseSync, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as {
      name: string;
    }[]
  ).map((c) => c.name);
}

/** Every index name on `table`. */
export function indexesOf(db: DatabaseSync, table: string): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name`
      )
      .all(table) as { name: string }[]
  ).map((r) => r.name);
}

/** The `ON DELETE` action of the foreign key `table.column` carries. */
export function onDeleteOf(
  db: DatabaseSync,
  table: string,
  column: string
): string | undefined {
  const rows = db
    .prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`)
    .all() as { from: string; on_delete: string }[];
  return rows.find((r) => r.from === column)?.on_delete;
}

/** The minimum a party needs to exist. */
export function party(db: DatabaseSync, id: string): string {
  db.prepare(
    `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
     VALUES (?, 'person', ?, ?, ?)`
  ).run(id, id, BASELINE_NOW, BASELINE_NOW);
  return id;
}

/** The single `core_vault` row a self-binding or currency rule reads. */
export function vaultRow(db: DatabaseSync, selfPartyId: string | null): string {
  db.prepare(
    `INSERT INTO core_vault (vault_id, self_party_id, display_name, status, base_currency, settings_json, created_at)
     VALUES ('v1', ?, 'v', 'active', 'EUR', '{}', ?)`
  ).run(selfPartyId, BASELINE_NOW);
  return "v1";
}
