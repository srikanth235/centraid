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
