import { EXPECTED_SQLITE_VEC_VERSION } from "./sqlite-vec-version";

/**
 * Thrown when sqlite-vec loaded but is not the version this repo pins. The two
 * native artifacts (Expo's bundled `.so`, the iOS source build) are checked
 * against each other and against the constant at build time; this is the same
 * question asked of the shell that actually shipped, where a stale
 * `vec.xcframework` left over from an older tag is the case a file check
 * cannot see.
 */
export class ReplicaSqliteVecVersionError extends Error {
  constructor(readonly actual: string) {
    super(
      `expo-sqlite loaded sqlite-vec ${actual}, but this build pins ` +
        `${EXPECTED_SQLITE_VEC_VERSION} (apps/mobile/src/lib/replica/sqlite-vec-version.ts). ` +
        "Rebuild the native app: on iOS delete apps/mobile/ios/vec.xcframework " +
        "and re-run scripts/build-sqlite-vec-ios.sh before `pod install`."
    );
    this.name = "ReplicaSqliteVecVersionError";
  }
}
