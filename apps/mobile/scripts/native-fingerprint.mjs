#!/usr/bin/env node
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
import { createFingerprintAsync } from '@expo/fingerprint';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const platform = process.argv[2];
if (platform !== 'ios' && platform !== 'android') {
  process.stderr.write('usage: native-fingerprint.mjs <ios|android>\n');
  process.exit(2);
}

// scripts/ → apps/mobile. Resolve relative to this file, not cwd: gradle and
// the monorepo root both invoke Expo tooling from different cwds (see the same
// note in app.config.ts).
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const fingerprint = await createFingerprintAsync(projectRoot, { platforms: [platform] });
// Guard against a silent empty digest becoming a constant (always-hit) key.
if (!fingerprint.hash || fingerprint.sources.length === 0) {
  process.stderr.write(
    `::error::empty ${platform} fingerprint — refusing to emit a constant key\n`,
  );
  process.exit(1);
}
process.stdout.write(fingerprint.hash);
