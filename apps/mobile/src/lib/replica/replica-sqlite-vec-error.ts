/**
 * Thrown when the op-sqlite build was compiled without sqlite-vec (issue
 * #721's B4 follow-on: vector search over photo embeddings). Mirrors
 * `ReplicaFts5UnavailableError` — same shape, same reason a build can be
 * missing the extension (the compile-time define op-sqlite only turns on
 * when it finds `"op-sqlite": { "sqliteVec": true }` in the package.json it
 * resolves, per `op-sqlite-build-config.test.ts`), same instinct to fail
 * loud with the exact fix rather than crashing opaquely mid-query.
 *
 * UNLIKE `ReplicaFts5UnavailableError`, nothing throws this today. FTS5 gates
 * the replica store's own bootstrap (`OpSqliteDriver#assertCapabilities`)
 * because every replica needs it from the first read; sqlite-vec has no
 * consumer yet, so nothing calls `OpSqliteDriver#probeSqliteVec` — see that
 * method's own comment for why a build compiled before pods/gradle picked up
 * `sqliteVec: true` must still open. This class exists so the future
 * consumer has one error to throw, rather than inventing its own the day it
 * lands.
 */
export class ReplicaSqliteVecUnavailableError extends Error {
  constructor() {
    super(
      'op-sqlite was built without sqlite-vec. Add `"op-sqlite": { "sqliteVec": true }` to ' +
        "apps/mobile/package.json and rebuild the native app (expo prebuild + run)."
    );
    this.name = "ReplicaSqliteVecUnavailableError";
  }
}
