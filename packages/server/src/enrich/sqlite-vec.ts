import type { DatabaseSync } from "node:sqlite";

import { getLoadablePath } from "sqlite-vec";

const loaded = new WeakSet<DatabaseSync>();

export function loadSqliteVec(
  db: DatabaseSync,
  onUnavailable?: (reason: string) => void
): boolean {
  try {
    db.enableLoadExtension(true);
    try {
      db.loadExtension(getLoadablePath());
    } finally {
      db.enableLoadExtension(false);
    }
    db.prepare("SELECT vec_version() AS version").get();
    loaded.add(db);
    return true;
  } catch (error) {
    onUnavailable?.(error instanceof Error ? error.message : String(error));
    return false;
  }
}

export function hasSqliteVec(db: DatabaseSync): boolean {
  return loaded.has(db);
}
