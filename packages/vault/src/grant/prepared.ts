import type { DatabaseSync, StatementSync } from "node:sqlite";

const CACHES = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

export function prepared(db: DatabaseSync, sql: string): StatementSync {
  let cache = CACHES.get(db);
  if (!cache) {
    cache = new Map();
    CACHES.set(db, cache);
  }
  const hit = cache.get(sql);
  if (hit) return hit;
  const statement = db.prepare(sql);
  cache.set(sql, statement);
  return statement;
}
