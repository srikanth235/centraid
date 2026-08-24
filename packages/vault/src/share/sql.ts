// Row plumbing shared by the two halves of a share (#726).
//
// Both halves read and write tables whose shape is not worth restating in
// TypeScript (`tally_expense`, `core_collection_entry`, `locker_item`): the
// closure carries them column-for-column, so a column added to one of those
// tables crosses a vault boundary without anyone editing this package. The
// cast to `WireRow` is safe because none of those tables has a BLOB column —
// stated as a constraint on `WireValue` (closure.ts), not assumed here.

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { uuidv7 } from "../ids.js";
import type { WireRow } from "./closure.js";

export function one(
  db: DatabaseSync,
  table: string,
  column: string,
  value: string
): WireRow | undefined {
  return db
    .prepare(`SELECT * FROM "${table}" WHERE "${column}" = ?`)
    .get(value) as WireRow | undefined;
}

export function rows(
  db: DatabaseSync,
  table: string,
  column: string,
  value: string
): WireRow[] {
  return db
    .prepare(`SELECT * FROM "${table}" WHERE "${column}" = ?`)
    .all(value) as WireRow[];
}

export function insert(
  db: DatabaseSync,
  table: string,
  row: Record<string, unknown>
): void {
  const entries = Object.entries(row);
  const columns = entries.map(([column]) => `"${column}"`).join(", ");
  const slots = entries.map(() => "?").join(", ");
  db.prepare(`INSERT INTO "${table}" (${columns}) VALUES (${slots})`).run(
    ...(entries.map(([, value]) => value) as SQLInputValue[])
  );
}

/**
 * Projected rows REUSE the origin's uuidv7 (ids are globally unique, which
 * makes provenance trivial to read). The only escape is a genuine collision —
 * the audience already holds a different row under that id — where a fresh id
 * is minted rather than corrupting either row.
 */
export function freeId(
  db: DatabaseSync,
  table: string,
  column: string,
  preferred: string
): string {
  const taken = db
    .prepare(`SELECT 1 AS present FROM "${table}" WHERE "${column}" = ?`)
    .get(preferred);
  return taken ? uuidv7() : preferred;
}

/** Text column read off a row whose shape is not declared, or null. */
export function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
