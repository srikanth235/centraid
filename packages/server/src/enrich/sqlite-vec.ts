// `sqlite-vec` loader (#721): the vault ships no native binaries, so the gateway
// supplies the extension through its `loadExtensions` seam.
//
// SECURITY. `enableLoadExtension(true)` also exposes SQL `load_extension()` on the
// handle `vault_sql` runs owner SQL on — open and shut synchronously here: never
// hoist the revoke, never make this async, never add a second load site. Failure
// is a capability answer (`hasSqliteVec` → fallback to `scanEmbeddings`); derived
// data never gates.

import type { DatabaseSync } from "node:sqlite";

import { getLoadablePath } from "sqlite-vec";

/** Per-handle: registration is connection-scoped. */
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
      // Revoked even on failure: a half-loaded handle keeps no door open.
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
