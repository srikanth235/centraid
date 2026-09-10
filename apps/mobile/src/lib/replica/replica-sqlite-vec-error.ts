/**
 * Thrown when the expo-sqlite build was compiled without sqlite-vec (#721:
 * vector search over face embeddings). Mirrors `ReplicaFts5UnavailableError` —
 * same shape, same reason a build can be missing the extension
 * (`withSQLiteVecExtension` on the expo-sqlite plugin block; 57.0.2
 * pre-bundles `vec.so` for Android and no `vec.xcframework`, so iOS gets its
 * framework from `scripts/build-sqlite-vec-ios.sh` at build time), same
 * instinct to fail loud with the exact fix rather than crashing opaquely
 * mid-query.
 *
 * It is thrown from `ExpoSeatDriver.open`, beside the FTS5 probe: the phone's
 * two offline search lanes are keyword (fts5) and people/similar faces
 * (`vec_distance_cosine` over the replicated face vectors), both answered out
 * of the seat's own file, so a seat that cannot serve one of them is a seat
 * that opened into a half-working app. Finding that out at open, with the
 * build flag named, is cheaper than finding it out inside a query.
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
