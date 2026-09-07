/**
 * Thrown when the expo-sqlite build was compiled without sqlite-vec (#721:
 * vector search over photo embeddings). Mirrors
 * `ReplicaFts5UnavailableError` — same shape, same reason a build can be
 * missing the extension (`withSQLiteVecExtension` on the expo-sqlite plugin
 * block; 57.0.2 pre-bundles `vec.so` for Android and no `vec.xcframework`, so
 * iOS gets its framework from `scripts/build-sqlite-vec-ios.sh` at build
 * time), same instinct to fail loud with the exact fix rather than crashing
 * opaquely mid-query.
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
        "`withSQLiteVecExtension: true` on the expo-sqlite plugin block in " +
        "apps/mobile/app.config.ts and rebuild the native app. On iOS the " +
        "framework itself is built by apps/mobile/scripts/build-sqlite-vec-ios.sh, " +
        "which must run before `pod install`."
    );
    this.name = "ReplicaSqliteVecUnavailableError";
  }
}
