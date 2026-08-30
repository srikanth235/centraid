// The authority plane's statement cache (#883, ruling V-delivery: delivery is
// "diff-based, doorbell-filtered, statement-cached"). Every read the delivery
// loop makes runs once per commit per grant, so re-compiling the same SQL each
// time was pure overhead — and the first-paint statement budget counts
// `prepare`, so a hot path that re-prepares is a measurable cost, not a
// theoretical one.
//
// Keyed by the connection object, so a closed-and-reopened vault gets a fresh
// cache and nothing survives its database. Schema-changing rungs run at OPEN,
// before any plane read compiles a statement against the old shape; a statement
// cache is therefore never the thing that outlives a migration.

import type { DatabaseSync, StatementSync } from "node:sqlite";

const CACHES = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/** The one compiled statement for this SQL on this connection. */
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
