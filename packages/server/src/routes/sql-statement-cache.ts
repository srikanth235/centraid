/*
 * Per-connection prepared-statement cache (#659).
 *
 * `db.prepare()` re-parses and re-plans the SQL every time. That is fine once
 * per process and expensive once per row: the replica projection calls its
 * consent lookups once per change entry, and a poll carries up to a thousand.
 *
 * Keyed by the `DatabaseSync` handle in a WeakMap, so statements are released
 * with the connection and a remounted vault plane never reuses a statement
 * compiled against a closed handle. Only for SQL whose TEXT is fixed —
 * identifiers interpolated from a closed set are fine (each distinct string
 * simply gets its own entry), user values must still be bound parameters.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";

const cache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

export function preparedStatement(
  db: DatabaseSync,
  sql: string
): StatementSync {
  let perDb = cache.get(db);
  if (!perDb) {
    perDb = new Map<string, StatementSync>();
    cache.set(db, perDb);
  }
  const existing = perDb.get(sql);
  if (existing) return existing;
  const statement = db.prepare(sql);
  perDb.set(sql, statement);
  return statement;
}
