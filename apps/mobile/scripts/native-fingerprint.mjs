#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Print the {@link https://docs.expo.dev/versions/latest/sdk/fingerprint/ @expo/fingerprint}
 * hash of this app's *native* build inputs for one platform — nothing else.
 *
 * Why this exists (issue #535, mobile CI cost):
 * The nightly iOS/Android jobs cache the compiled dev build keyed on a
 * fingerprint of "everything that can change the binary". A JS/TS commit is
 * served by Metro at runtime, so it must NOT bust the ~32-minute native build;
 * a change to a config plugin, a native module, the bundle id, or an autolinked
 * pod MUST. The old key was a hand-rolled `git ls-files | shasum` over
 * `apps/mobile/ios`, `.github/workflows/e2e.yml`, etc. That over-hashed:
 * editing the workflow file — or anything under `ios/` that a prior build had
 * dirtied — invalidated the cache and forced a full rebuild on an otherwise
 * JS-only night. @expo/fingerprint hashes exactly the native inputs (config
 * plugins, autolinked native modules, the resolved Expo config, the RN
 * version) and ignores `src/**` and the CI YAML, so the warm path is reached
 * far more often. Since #996 it also ignores the generated `ios/` + `android/`
 * projects: those are prebuild OUTPUTS of the same inputs, and hashing them
 * would key the cache on whether a prebuild had already run. See the e2e.yml comment on
 * the fingerprint step for how the host toolchain (Xcode/SDK) is folded in
 * separately — fingerprint hashes the *project*, not the *machine*.
 *
 * Usage: `node scripts/native-fingerprint.mjs <ios|android>` → prints the hash
 * to stdout with no trailing newline, suitable for `>> "$GITHUB_OUTPUT"`.
 */
import { createFingerprintAsync, SourceSkips } from "@expo/fingerprint";

// scripts/ → apps/mobile. Resolve relative to this file, not cwd: gradle and
// the monorepo root both invoke Expo tooling from different cwds (see the same
// note in app.config.ts).
const projectRoot = path.resolve(import.meta.dirname, "..");

export const NATIVE_FINGERPRINT_IGNORE_PATHS = [
  "native-fingerprints.json",
  // THE PREBUILD OUTPUTS ARE NOT INPUTS (#996). `ios/` and `android/` are
  // generated and gitignored, so they exist on a developer's disk and do not
  // exist on a fresh CI checkout. Hashing either would make every fingerprint
  // host-stateful: the same commit would produce two values depending on
  // whether a prebuild had run, and the committed ratchet could never settle.
  // Ignoring them leaves @expo/fingerprint's `bareNativeDir` source present but
  // empty (`hash: null`), which is exactly the value it takes when the
  // directory is absent — the two states become indistinguishable, which is the
  // point. `verify-native-state.mjs` L3 asserts that emptiness, so deleting
  // these two entries fails a gate rather than quietly localising every hash.
  "ios/**",
  "android/**",
  // CocoaPods reconstructs these git-ignored Iroh bindings from the tag
  // and checksum pinned in CentraidTunnel.podspec. Hashing the downloaded
  // products as well as that recipe makes the result depend on whether
  // `pod install` has run, so a clean CI checkout and a built worktree
  // disagree even though their native inputs are identical.
  "modules/centraid-tunnel/ios/Iroh.xcframework/**/*",
  "modules/centraid-tunnel/ios/IrohLib.swift",
  "modules/centraid-tunnel/ios/.iroh-version",
];

/**
 * Fingerprint options shared by the CLI and the identity ratchet (#646).
 *
 * `PackageJsonScriptsAll` deafens pure script-key reorders (oxfmt
 * `sortPackageJson.sortScripts`, hand edits) so they do not move iOS/Android
 * identity without real native intent. Tradeoff: a script that genuinely
 * altered prebuild output would no longer bust the cache — nothing in
 * `apps/mobile` scripts does that today.
 */
export const NATIVE_FINGERPRINT_SOURCE_SKIPS =
  SourceSkips.PackageJsonScriptsAll;

export function nativeFingerprintOptions(platform) {
  if (platform !== "ios" && platform !== "android") {
    throw new Error(`unsupported native fingerprint platform: ${platform}`);
  }
  return {
    platforms: [platform],
    // The committed expectation is the ratchet output, not an input. Including
    // it would make every refresh self-referential and impossible to settle.
    ignorePaths: NATIVE_FINGERPRINT_IGNORE_PATHS,
    sourceSkips: NATIVE_FINGERPRINT_SOURCE_SKIPS,
  };
}

/**
 * The hash AND the source list it was computed from. The identity ratchet
 * (`verify-native-state.mjs`) checks the sources as well as the digest: a
 * fingerprint that quietly stopped reading a config plugin would keep matching
 * the committed hash forever, which is a silent gate rather than a red one.
 */
export async function fingerprintReportForPlatform(platform) {
  const fingerprint = await createFingerprintAsync(
    projectRoot,
    nativeFingerprintOptions(platform)
  );
  // Guard against a silent empty digest becoming a constant (always-hit) key.
  if (!fingerprint.hash || fingerprint.sources.length === 0) {
    throw new Error(
      `empty ${platform} fingerprint — refusing to emit a constant key`
    );
  }
  return { hash: fingerprint.hash, sources: fingerprint.sources };
}

export async function fingerprintForPlatform(platform) {
  return (await fingerprintReportForPlatform(platform)).hash;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const platform = process.argv[2];
  if (platform !== "ios" && platform !== "android") {
    process.stderr.write("usage: native-fingerprint.mjs <ios|android>\n");
    process.exit(2);
  }
  try {
    process.stdout.write(await fingerprintForPlatform(platform));
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(1);
  }
}
