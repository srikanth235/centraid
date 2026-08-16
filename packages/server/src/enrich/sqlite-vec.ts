// The vector-search extension loader (issue #721 E3) — the gateway half of the
// `OpenVaultOptions.loadExtensions` seam.
//
// WHY THE GATEWAY OWNS THIS. `packages/vault` is deliberately dependency-light
// and ships no native binaries; `sqlite-vec` is a per-platform `.dylib`/`.so`/
// `.dll` delivered through optional npm dependencies. So the vault exposes a
// hook and the gateway — which already owns sharp, jpeg-js and the rest of the
// native surface — supplies the loader. Same shape as `previewCodec`.
//
// SECURITY: THE PERMISSION IS OPENED AND SHUT IN THREE STATEMENTS.
// `enableLoadExtension(true)` also makes SQL's `load_extension()` callable, and
// the owner's `vault_sql` surface runs arbitrary SQL on THIS SAME HANDLE. A
// handle left extension-enabled would therefore turn "run a query" into "load
// native code from any path on this host". So the permission is revoked
// immediately after the one load we intend, in the same synchronous block, with
// no `await` between: after `enableLoadExtension(false)` SQLite answers
// `load_extension()` with "not authorized" for the rest of the handle's life.
// Do not hoist the revoke, do not make this function async, and do not add a
// second load site later — add it between these two lines.
//
// FEATURE DETECTION, NOT A REQUIREMENT. Any failure — an unsupported platform,
// an optional dependency npm declined to install, a build of node:sqlite
// without extension support — leaves the vault open and unmarked. Callers ask
// `hasSqliteVec` and fall back to the exact JS cosine scan in
// `@centraid/vault`'s `scanEmbeddings`, which returns the same ranking. Derived
// data enriches, it never gates: no search may fail because a vector index is
// missing.

import type { DatabaseSync } from "node:sqlite";

import { getLoadablePath } from "sqlite-vec";

/**
 * Handles this process successfully loaded the extension into. Per-handle
 * because extension registration is connection-scoped and a vault switch mints
 * a fresh handle; weak so a closed vault's entry leaves with it — the same
 * stance `enrich/clusters.ts` takes for its per-connection memo.
 */
const loaded = new WeakSet<DatabaseSync>();

/**
 * Load `sqlite-vec` into one freshly opened vault handle. Returns whether the
 * handle now carries the extension. Never throws: an unavailable platform is a
 * capability answer, not a vault-open failure.
 */
export function loadSqliteVec(
  db: DatabaseSync,
  onUnavailable?: (reason: string) => void
): boolean {
  try {
    // A boundary, not a just-in-case catch (coding-standards.md): every step
    // below reaches outside this process — npm's optional-dependency install,
    // the host's dynamic loader, the runtime's build flags — and the product
    // decision for all of them is the same single fallback.
    db.enableLoadExtension(true);
    try {
      db.loadExtension(getLoadablePath());
    } finally {
      // Revoked whether or not the load succeeded: a half-loaded handle must
      // not keep the SQL-level `load_extension()` door open either.
      db.enableLoadExtension(false);
    }
    // Prove the functions are actually callable rather than trusting the load.
    db.prepare("SELECT vec_version() AS version").get();
    loaded.add(db);
    return true;
  } catch (error) {
    onUnavailable?.(error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** Whether this vault handle can answer `vec_distance_cosine(...)`. */
export function hasSqliteVec(db: DatabaseSync): boolean {
  return loaded.has(db);
}
