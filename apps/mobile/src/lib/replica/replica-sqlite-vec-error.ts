/**
 * Thrown when the expo-sqlite build was compiled without sqlite-vec (#721:
 * vector search over photo embeddings). Mirrors
 * `ReplicaFts5UnavailableError` — same shape, same reason a build can be
 * missing the extension (`withSQLiteVecExtension` on the expo-sqlite plugin
 * block, which in 57.0.2 ships `vec.so` for Android and NOTHING for iOS —
 * there is no `vec.xcframework` in the tarball), same instinct to fail
 * loud with the exact fix rather than crashing opaquely mid-query.
 *
 * UNLIKE `ReplicaFts5UnavailableError`, nothing throws this today. FTS5 gates
 * the replica store's own bootstrap (`ExpoSqliteDriver#assertCapabilities`)
 * because every replica needs it from the first read; sqlite-vec has no
 * consumer yet, so nothing calls `ExpoSqliteDriver#probeSqliteVec` — see that
 * method's own comment for why a build compiled before pods/gradle picked up
 * `sqliteVec: true` must still open. This class exists so the future
 * consumer has one error to throw, rather than inventing its own the day it
 * lands.
 */
export class ReplicaSqliteVecUnavailableError extends Error {
  constructor() {
    super(
      "expo-sqlite was built without sqlite-vec. Set " +
        "`android: { withSQLiteVecExtension: true }` on the expo-sqlite plugin " +
        "block in apps/mobile/app.config.ts and rebuild the native app (expo " +
        "prebuild + run). iOS ships no sqlite-vec bundle at all in 57.0.2."
    );
    this.name = "ReplicaSqliteVecUnavailableError";
  }
}
