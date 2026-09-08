#!/usr/bin/env node
/**
 * Print a content hash of everything that ends up inside the app's EMBEDDED
 * Hermes bundle — and nothing that does not.
 *
 * WHY THIS EXISTS (issue #892 Phase 0). The Android device lanes key their apk
 * cache on `native-fingerprint.mjs`, which is `@expo/fingerprint` over the
 * NATIVE inputs and deliberately ignores `src/**`. Under the dev client that was
 * exactly right: Metro served the JS live, so a JS-only commit had no business
 * rebuilding a binary. #890 W1 moved every device lane onto the RELEASE
 * artifact, where the JS is compiled into the apk — and the key did not move
 * with it. The consequence is the worst shape a cache can have: a JS-only PR
 * (the most common PR in this repo) restored `main`'s apk, and the critical five
 * drove `main`'s JS. Green, fast, and measuring the wrong commit.
 *
 * WHAT IT HASHES, AND WHY IT IS A PATH LIST RATHER THAN A BUNDLER RUN. Asking
 * Metro is the exact answer, and it costs a Metro run — inside a twelve-minute
 * gate, before the thing being cached. This is the cheap over-approximation: the
 * app's own source plus the workspace packages it imports plus the resolution
 * inputs. Over-approximating is the safe direction — a stale apk is a false
 * pass, an unnecessary rebuild is only minutes, and gradle's build-directory
 * cache (keyed on the NATIVE fingerprint, untouched here) means that rebuild is
 * a repackage rather than a native compile. That asymmetry is the whole design:
 * miss the apk cache, hit the gradle cache.
 *
 * Tracked files only (`git ls-files`), sorted, path and content both folded in,
 * so the digest is identical on a clean CI checkout and a built worktree and can
 * never depend on gitignored build products the way the pre-#535 hand-rolled key
 * did.
 *
 * Usage: `node scripts/js-bundle-fingerprint.mjs` → prints the bare hash with no
 * trailing newline, suitable for `>> "$GITHUB_OUTPUT"`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// scripts/ → apps/mobile → repo root.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * Pathspecs, repo-root relative, of everything the release bundle is built from.
 *
 * `apps/mobile/{android,ios}` are deliberately ABSENT: they are the native
 * project and are already the whole subject of `native-fingerprint.mjs`. Adding
 * them here would make the two components move together and collapse the apk
 * cache into "rebuild on any change", which is the state #535 spent a fingerprint
 * getting out of.
 */
export const JS_BUNDLE_PATHSPECS = [
  // The app itself: screens, kit, lib, the entry point, the navigators, and the
  // Expo/Metro/Babel configuration that decides how they are resolved and
  // transformed.
  "apps/mobile/src",
  "apps/mobile/store",
  "apps/mobile/App.tsx",
  "apps/mobile/index.ts",
  "apps/mobile/lazy-screens.tsx",
  "apps/mobile/navigators.tsx",
  "apps/mobile/app.config.ts",
  "apps/mobile/babel.config.js",
  "apps/mobile/metro.config.js",
  "apps/mobile/package.json",
  "apps/mobile/tsconfig.json",
  // The workspace packages the phone imports. `apps/mobile/package.json`
  // declares exactly these four as `workspace:*` dependencies; the bundle
  // contains their source, so their source is a bundle input.
  "packages/client/src",
  "packages/core/src",
  "packages/design/src",
  "packages/blueprints/src",
  "packages/blueprints/apps",
  // Dependency resolution. A lockfile change can swap a transitive library the
  // bundle embeds without touching one line of first-party source.
  "bun.lock",
];

/**
 * What the pathspecs sweep up but the bundle can never contain (#931 item 5).
 *
 * The same shape `G-turbo-inputs` (#915) fixed for the build hash. A Hermes
 * release bundle is reachable from `index.ts`; a `*.test.ts` beside a module is
 * imported by no production path, a `__tests__` folder by none at all, and a
 * `.md` by nothing that runs. Yet a test-only edit under one of the four
 * bundled workspace packages moved this digest, missed the apk cache, and made
 * `mobile-device-gate` pay a cold 21.4-minute Android build to prove that a
 * `queries.test.ts` still passed (#934). Because the excluded files cannot be
 * inside the artifact, dropping them cannot produce a stale hit — the
 * over-approximation this module documents gets narrower, not wrong.
 */
const NOT_IN_BUNDLE =
  /(?:^|\/)__tests__\/|\.(?:test|spec|test-fixtures)\.[^/]*$|\.md$/u;

/**
 * Is this tracked path something the release bundle can actually contain?
 * @param {string} file A repo-relative path.
 * @returns {boolean} False for test, spec, fixture and markdown files.
 */
export function isBundleInput(file) {
  return !NOT_IN_BUNDLE.test(file);
}

/** Tracked files under the bundle pathspecs, repo-relative and sorted. */
export function bundleInputFiles(
  cwd = REPO_ROOT,
  pathspecs = JS_BUNDLE_PATHSPECS
) {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...pathspecs], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean).filter(isBundleInput).sort();
}

/**
 * Fold a file list into one digest.
 *
 * The PATH is hashed alongside the content so a pure rename — which changes what
 * Metro resolves — moves the digest even when every byte is preserved.
 *
 * @param {string[]} files repo-relative paths, already sorted
 * @param {(file: string) => Buffer | string} read content reader (injectable for tests)
 * @returns {string} hex sha256
 */
export function digestFiles(files, read) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(read(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function jsBundleFingerprint(cwd = REPO_ROOT) {
  const files = bundleInputFiles(cwd);
  // A silent empty list would produce a constant digest — an always-hit key,
  // i.e. exactly the stale-apk failure this module exists to remove. Fail loud.
  if (files.length === 0) {
    throw new Error(
      "no tracked JS bundle inputs matched — refusing to emit a constant key"
    );
  }
  return digestFiles(files, (file) => readFileSync(path.join(cwd, file)));
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    // 16 hex chars: the key already carries a jdk and a native component, and
    // a cache key is not a security boundary. 64 bits of collision resistance
    // over a repo's worth of commits is ample.
    process.stdout.write(jsBundleFingerprint().slice(0, 16));
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(1);
  }
}
