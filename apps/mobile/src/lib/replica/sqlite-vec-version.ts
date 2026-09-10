/**
 * THE sqlite-vec VERSION THE PHONE IS BUILT AGAINST — one constant, three
 * artifacts, and a fourth version that is deliberately not this one.
 *
 * On the phone the extension arrives twice: expo-sqlite 57.0.2 pre-bundles
 * `android/vec/<abi>/vec.so`, and iOS builds `vec.xcframework` from source at
 * the tag pinned in `apps/mobile/scripts/build-sqlite-vec-ios.sh`. Two
 * artifacts from two places is the shape that drifts, so both are asserted
 * against this constant by `apps/mobile/scripts/sqlite-vec-version.test.mjs`,
 * and the extension the phone actually loaded is asserted against it at open
 * (`ExpoSeatDriver.open`) — a phone answering `vec_version()` with something
 * else is running a shell nobody in this repo pinned.
 *
 * THE GATEWAY IS ON A DIFFERENT VERSION, AND THAT IS THE STATE, NOT A BUG.
 * The gateway loads the `sqlite-vec` npm package (`sqlite-vec@0.1.9`, pinned
 * in `packages/server/package.json` and resolved in `bun.lock`) through
 * `packages/server/src/enrich/sqlite-vec.ts`; the phone is on
 * `v0.1.7-alpha.2`, the newest tag the iOS source build and Expo's bundled
 * `.so` agree on. The two planes never compare extension versions with each
 * other — they compare vectors, and `vec_distance_cosine` over the same
 * `enrich_embedding.vector` bytes at the same `dim` is the same answer on
 * both. Raising the phone's pin means moving a native artifact on both
 * platforms and is reported before it is done, never as a side effect.
 */
export const EXPECTED_SQLITE_VEC_VERSION = "v0.1.7-alpha.2";
