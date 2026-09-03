import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { uuidv7 } from "../ids.js";
import { entitySupertypeMembers } from "../schema/entity.js";
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

const ENTITY_TABLES: ReadonlySet<string> = new Set(
  entitySupertypeMembers().map(([, physical]) => physical)
);

export function freeId(
  db: DatabaseSync,
  table: string,
  column: string,
  preferred: string
): string {
  const taken = db
    .prepare(`SELECT 1 AS present FROM "${table}" WHERE "${column}" = ?`)
    .get(preferred);
  if (taken) return uuidv7();
  if (!ENTITY_TABLES.has(table)) return preferred;
  const held = db
    .prepare(`SELECT 1 AS present FROM core_entity WHERE entity_id = ?`)
    .get(preferred);
  return held ? uuidv7() : preferred;
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
