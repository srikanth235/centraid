/*
 * WHAT THE APPLIER NEEDS TO KNOW ABOUT A TABLE, read once per table per
 * connection (#996, R10).
 *
 * `primaryKeyOf` runs `PRAGMA table_info` on every call, and a bootstrap
 * applies every member of a closure — ~800 rows for a 200-photo album — each
 * of which asked three times. That was 4.6x the share journey's ceiling and
 * none of it was work. A table's key is fixed for the life of a connection,
 * so it is read once.
 */

import type { DatabaseSync } from "node:sqlite";

import { primaryKeyOf } from "../replica/log.js";
import { entitySupertypeMembers } from "../schema/entity.js";

export function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Tables whose ids live in the one `core_entity` namespace. */
export const ENTITY_TABLES: ReadonlySet<string> = new Set(
  entitySupertypeMembers().map(([, physical]) => physical)
);

/** Physical table for a logical entity name — the polymorphic resolution. */
export const PHYSICAL_OF_ENTITY: ReadonlyMap<string, string> = new Map(
  entitySupertypeMembers()
);

export interface TableShape {
  readonly key: readonly string[];
  /** Single-column id when the table's ids live in `core_entity`. */
  readonly idColumn: string | undefined;
}

const SHAPES = new WeakMap<DatabaseSync, Map<string, TableShape>>();

export function shapeOf(audience: DatabaseSync, table: string): TableShape {
  let perDb = SHAPES.get(audience);
  if (!perDb) {
    perDb = new Map();
    SHAPES.set(audience, perDb);
  }
  const held = perDb.get(table);
  if (held) return held;
  const key = primaryKeyOf(audience, table);
  const shape: TableShape = {
    key,
    idColumn: ENTITY_TABLES.has(table) && key.length === 1 ? key[0] : undefined,
  };
  perDb.set(table, shape);
  return shape;
}

/** The single-column id of an entity table; `undefined` for anything else. */
export function entityIdColumn(
  audience: DatabaseSync,
  table: string
): string | undefined {
  return shapeOf(audience, table).idColumn;
}

/**
 * Whether a table carries `row_version` at all. Not every claimed table does —
 * a collection entry and a tag are append-and-delete rows with no `updated_at`
 * and so no version — and a table without one cannot report divergence, which
 * is a fact about the table rather than a gap in the applier.
 */
const VERSIONED = new WeakMap<DatabaseSync, Map<string, boolean>>();

export function hasRowVersion(audience: DatabaseSync, table: string): boolean {
  let perDb = VERSIONED.get(audience);
  if (!perDb) {
    perDb = new Map();
    VERSIONED.set(audience, perDb);
  }
  const held = perDb.get(table);
  if (held !== undefined) return held;
  const columns = audience
    .prepare(`SELECT name FROM pragma_table_info(?)`)
    .all(table) as unknown as { name: string }[];
  const answer = columns.some((column) => column.name === "row_version");
  perDb.set(table, answer);
  return answer;
}
