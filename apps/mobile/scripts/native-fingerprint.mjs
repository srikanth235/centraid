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
 * plugins, autolinked native modules, the bare `ios/` + `android/` projects,
 * the resolved Expo config, the RN version) and ignores `src/**` and the CI
 * YAML, so the warm path is reached far more often. See the e2e.yml comment on
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
  // Xcode creates this nested workspace on first open/build. The committed
  // app uses Centraid.xcworkspace; this ignored IDE metadata is absent on a
  // clean Linux checkout and must not make the iOS ratchet host-stateful.
  "ios/Centraid.xcodeproj/project.xcworkspace/**/*",
  // Kotlin 2.1 writes local daemon error reports here during a native
  // compile. They describe the machine/build attempt, not binary inputs,
  // and Expo's defaults do not yet exclude this directory. Without this,
  // merely running the compile gate changes the next cache key.
  "android/.kotlin/**/*",
  // CocoaPods reconstructs these git-ignored Iroh bindings from the tag
  // and checksum pinned in CentraidTunnel.podspec. Hashing the downloaded
  // products as well as that recipe makes the result depend on whether
  // `pod install` has run, so a clean CI checkout and a built worktree
  // disagree even though their native inputs are identical.
  "modules/centraid-tunnel/ios/Iroh.xcframework/**/*",
  "modules/centraid-tunnel/ios/IrohLib.swift",
  "modules/centraid-tunnel/ios/.iroh-version",
  // The react-native-maps pod install rewrites this one-line marker from
  // its package default to the app's Google Maps setting. The app config
  // and package sources remain hashed; the reconstructed marker must not
  // make either platform's identity depend on whether CocoaPods has run.
  "../../node_modules/react-native-maps/ios/AirMaps/RNMapsDefines.h",
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

export async function fingerprintForPlatform(platform) {
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
  return fingerprint.hash;
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
