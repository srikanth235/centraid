#!/usr/bin/env node
/**
 * Native input purity + identity ratchet for apps/mobile (#587 E23, #646;
 * rebuilt for Continuous Native Generation in #996).
 *
 * `ios/` and `android/` are prebuild OUTPUTS, and #1011 TRACKS them so that a
 * native change arrives as a reviewable diff rather than as a hash nobody can
 * read. That is why L1 asks about drift rather than absence (R-NY-17, #1015):
 * the question a tracked generated tree raises is not "is it here" but "is it
 * still what the inputs produce".
 *
 * The rest of the CNG posture stands. The checks that read a committed
 * Podfile.lock as a source of truth (pod-lock completeness, pod version
 * coherence, REACT_NATIVE_PATH hygiene) stay retired: the lock is regenerated
 * by `pod install` inside the macOS lanes, so a repo-wide checker has nothing
 * independent to compare it to.
 *
 * Layers (fail-closed; L1-L3 must pass before fingerprints may be written):
 *   L1 generated-tree fidelity — ios/ and android/ are tracked, are not
 *     ignored, and each sits at the git tree id last blessed with the inputs
 *   L2 input coverage — every config plugin and local module directory is in
 *     the fingerprint's source list, and each module declares the platforms its
 *     directories imply
 *   L3 host independence — no prebuild output contributes to the hash, so a
 *     prebuilt worktree and a fresh checkout agree
 *   L4 identity ratchet — committed native-fingerprints.json vs @expo/fingerprint
 *
 * CLI (sole entry \`ci:native-state\`; no alias):
 *   bun run --cwd apps/mobile ci:native-state           # verify
 *   bun run --cwd apps/mobile ci:native-state --status  # per-layer why
 *   bun run --cwd apps/mobile ci:native-state --write   # refresh hashes after L1-L3
 */
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fingerprintReportForPlatform } from "./native-fingerprint.mjs";
import {
  attachRemediation,
  formatStatusReport,
  formatWriteSummary,
  parseNativeStateArgs,
  validateFingerprintInputCoverage,
  validateFingerprints,
  validateGeneratedTreesNotHashed,
  validateGeneratedTreeDrift,
  validateGeneratedTreesTracked,
  validateModulePlatformShape,
  FIX_INPUTS_HINT,
  GENERATED_NATIVE_DIRS,
  GENERATED_TREE_KEY,
} from "./verify-native-state-lib.mjs";

// Re-export pure API for existing tests and external importers.
export {
  attachRemediation,
  classifyNativeStateError,
  formatStatusReport,
  formatWriteSummary,
  parseNativeStateArgs,
  validateFingerprintInputCoverage,
  validateFingerprints,
  validateGeneratedTreesNotHashed,
  validateGeneratedTreeDrift,
  validateGeneratedTreesTracked,
  validateModulePlatformShape,
  WRITE_CMD,
  FIX_INPUTS_HINT,
  GENERATED_NATIVE_DIRS,
  GENERATED_TREE_KEY,
} from "./verify-native-state-lib.mjs";

const mobileRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(mobileRoot, "..", "..");

/**
 * The tracked half of L1, asked of git rather than of the filesystem: the
 * question is what the INDEX carries, and a worktree full of build output
 * answers it wrong.
 */
export function trackedGeneratedNativeFiles(cwd = repoRoot) {
  const output = execFileSync(
    "git",
    ["ls-files", "--", ...GENERATED_NATIVE_DIRS],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return output.split("\n").filter(Boolean);
}

/**
 * The ignore half of L1, asked of git so it survives however the rule is
 * spelled — a leading slash, a trailing slash, a parent `.gitignore`, or an
 * exclude file. It must answer FALSE now: a rule over a tracked tree keeps its
 * files committed while hiding every regeneration from `git status`.
 *
 * The path is queried WITH a trailing slash, and that is load-bearing: a
 * directory-only rule (`/ios/`) is invisible to `git check-ignore` on a bare
 * path when the directory is absent, which is the state a fresh checkout of a
 * future cut could be in. `--no-index` so the answer is the RULE's, independent
 * of what happens to be tracked; the tracked half is a separate check.
 */
export function generatedNativeDirsIgnored(cwd = repoRoot) {
  const ignored = {};
  for (const dir of GENERATED_NATIVE_DIRS) {
    try {
      execFileSync(
        "git",
        ["check-ignore", "--quiet", "--no-index", `${dir}/`],
        { cwd, stdio: "ignore" }
      );
      ignored[dir] = true;
    } catch {
      ignored[dir] = false;
    }
  }
  return ignored;
}

/**
 * The git tree object id of each generated tree — the drift half of L1.
 *
 * Read from the INDEX, not from HEAD and not from the filesystem. The index is
 * what the next commit will carry, so a regeneration and the `--write` that
 * blesses it belong in one commit rather than two; on a clean checkout — every
 * CI lane — the index IS HEAD, so the gate answers identically there. A
 * filesystem walk would answer neither question: build output, `DerivedData`
 * and a half-finished prebuild all live down there.
 *
 * `git write-tree` turns the index into tree objects without touching HEAD or
 * the worktree; `rev-parse <tree>:<dir>` then names the directory's own tree.
 * That id IS the directory's content: one byte changed anywhere under it moves
 * the id, and nothing else does. A path that is not a tree answers `undefined`,
 * which the validator treats as a finding rather than as a pass.
 */
export function generatedNativeTreeIds(cwd = repoRoot) {
  const ids = {};
  let root;
  try {
    root = execFileSync("git", ["write-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return Object.fromEntries(
      GENERATED_NATIVE_DIRS.map((dir) => [dir, undefined])
    );
  }
  for (const dir of GENERATED_NATIVE_DIRS) {
    try {
      ids[dir] = execFileSync("git", ["rev-parse", `${root}:${dir}`], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      ids[dir] = undefined;
    }
  }
  return ids;
}

/** Repo-owned config plugins, mobile-root-relative (the fingerprint's units). */
export async function discoverConfigPlugins(
  pluginsRoot = path.join(mobileRoot, "plugins")
) {
  let entries;
  try {
    entries = await readdir(pluginsRoot);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return [];
    throw error;
  }
  return entries
    .filter((file) => file.endsWith(".cjs"))
    .map((file) => `plugins/${file}`)
    .sort();
}

export async function loadLocalModulePlatforms(
  modulesRoot = path.join(mobileRoot, "modules")
) {
  let entries;
  try {
    entries = await readdir(modulesRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return [];
    throw error;
  }
  const dirs = entries.filter((e) => e.isDirectory());
  return Promise.all(
    dirs.map(async (entry) => {
      const moduleRoot = path.join(modulesRoot, entry.name);
      const configPath = path.join(moduleRoot, "expo-module.config.json");
      const [hasIosDir, hasAndroidDir] = await Promise.all([
        dirExists(path.join(moduleRoot, "ios")),
        dirExists(path.join(moduleRoot, "android")),
      ]);
      try {
        const config = JSON.parse(await readFile(configPath, "utf8"));
        return {
          moduleId: entry.name,
          config,
          hasIosDir,
          hasAndroidDir,
          missingConfig: false,
        };
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          return {
            moduleId: entry.name,
            config: null,
            hasIosDir,
            hasAndroidDir,
            missingConfig: true,
          };
        }
        throw error;
      }
    })
  );
}

async function dirExists(dir) {
  try {
    await readdir(dir);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return false;
    throw error;
  }
}

/** The per-platform module directories autolinking is expected to have found. */
export function moduleNativeDirsFor(platform, modulePlatforms) {
  return modulePlatforms
    .filter((mod) => (platform === "ios" ? mod.hasIosDir : mod.hasAndroidDir))
    .map((mod) => `modules/${mod.moduleId}/${platform}`)
    .sort();
}

/**
 * Collect L1–L3 errors (purity + coverage + host independence). Does not
 * compare fingerprints against the committed file.
 */
export function collectInputErrors({
  trackedNativeFiles,
  ignoredDirs,
  blessedTreeIds,
  treeIds,
  modulePlatforms,
  pluginFiles,
  reports,
}) {
  const errors = [
    ...validateGeneratedTreesTracked({ trackedNativeFiles, ignoredDirs }),
    ...validateGeneratedTreeDrift(blessedTreeIds, treeIds),
  ];
  for (const mod of modulePlatforms) {
    if (mod.missingConfig || mod.config == null) {
      errors.push(
        `L2 module shape: module ${mod.moduleId} is missing expo-module.config.json (${FIX_INPUTS_HINT})`
      );
      continue;
    }
    errors.push(
      ...validateModulePlatformShape({
        moduleId: mod.moduleId,
        config: mod.config,
        hasIosDir: mod.hasIosDir,
        hasAndroidDir: mod.hasAndroidDir,
      })
    );
  }
  for (const { platform, sources } of reports) {
    errors.push(
      ...validateFingerprintInputCoverage({
        platform,
        sources,
        pluginFiles,
        moduleNativeDirs: moduleNativeDirsFor(platform, modulePlatforms),
      }),
      ...validateGeneratedTreesNotHashed({ platform, sources })
    );
  }
  return errors;
}

export async function verifyNativeState(options = {}) {
  const { write = false, status = false } = options;
  const [expected, pluginFiles, modulePlatforms, ...reports] =
    await Promise.all([
      readJson(path.join(mobileRoot, "native-fingerprints.json")),
      discoverConfigPlugins(),
      loadLocalModulePlatforms(),
      ...["ios", "android"].map(async (platform) => ({
        platform,
        ...(await fingerprintReportForPlatform(platform)),
      })),
    ]);

  const treeIds = generatedNativeTreeIds();
  const inputErrors = collectInputErrors({
    trackedNativeFiles: trackedGeneratedNativeFiles(),
    ignoredDirs: generatedNativeDirsIgnored(),
    blessedTreeIds: expected[GENERATED_TREE_KEY],
    treeIds,
    modulePlatforms,
    pluginFiles,
    reports,
  });
  const inputInventory = {
    pluginFiles,
    modules: modulePlatforms.map((mod) => mod.moduleId).sort(),
  };
  const actualByPlatform = Object.fromEntries(
    reports.map(({ platform, hash }) => [platform, hash])
  );

  // The drift half of L1 is what a reviewed `--write` EXISTS to move, so it
  // does not block one; the rest of L1 (tracked, unignored) and L2/L3 still do,
  // because a tree nobody can review is not a tree anyone may bless.
  const blockingInputErrors = write
    ? inputErrors.filter(
        (error) => !error.startsWith("L1 generated tree drift:")
      )
    : inputErrors;

  if (write && blockingInputErrors.length > 0) {
    return {
      errors: attachRemediation(blockingInputErrors),
      wrote: false,
      statusText: status
        ? formatStatusReport({
            errors: blockingInputErrors,
            inputInventory,
            fingerprints: null,
          })
        : null,
      writeSummary: null,
      inputInventory,
    };
  }

  if (write) {
    const next = {
      _comment:
        "Expected @expo/fingerprint hashes over the CNG inputs (app.config.ts, plugins/, modules/, the dependency set), plus the git tree id of each GENERATED tree at the commit those inputs were blessed on. Changing either must be a reviewed act — see docs/traps/mobile-native-state.md.",
      ios: actualByPlatform.ios,
      android: actualByPlatform.android,
      [GENERATED_TREE_KEY]: Object.fromEntries(
        GENERATED_NATIVE_DIRS.map((dir) => [dir, treeIds[dir]])
      ),
    };
    const platformsMoved = [
      ...["ios", "android"].filter((p) => expected[p] !== next[p]),
      ...GENERATED_NATIVE_DIRS.filter(
        (dir) => expected[GENERATED_TREE_KEY]?.[dir] !== treeIds[dir]
      ),
    ];
    await writeFile(
      path.join(mobileRoot, "native-fingerprints.json"),
      `${JSON.stringify(next, null, 2)}\n`,
      "utf8"
    );
    return {
      errors: [],
      wrote: true,
      statusText: status
        ? formatStatusReport({
            errors: [],
            inputInventory,
            fingerprints: { expected: next, actual: actualByPlatform },
          })
        : null,
      writeSummary: formatWriteSummary({
        previous: expected,
        next,
        inputInventory,
        platformsMoved,
      }),
      inputInventory,
      fingerprints: { expected: next, actual: actualByPlatform },
    };
  }

  const identityErrors = validateFingerprints(expected, actualByPlatform);
  return {
    errors: attachRemediation([...inputErrors, ...identityErrors]),
    wrote: false,
    statusText: status
      ? formatStatusReport({
          errors: [...inputErrors, ...identityErrors],
          inputInventory,
          fingerprints: { expected, actual: actualByPlatform },
        })
      : null,
    writeSummary: null,
    inputInventory,
    fingerprints: { expected, actual: actualByPlatform },
  };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  let flags;
  try {
    flags = parseNativeStateArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`native-state: ${error.message}`);
    process.exit(2);
  }
  if (flags.help) {
    console.log(`usage: verify-native-state.mjs [--status] [--write]
  (default)  verify L1–L4
  --status   human-readable per-layer report
  --write    recompute native-fingerprints.json only when L1–L3 pass`);
    process.exit(0);
  }
  const result = await verifyNativeState(flags);
  if (result.statusText) console.log(result.statusText);
  if (result.writeSummary) console.log(result.writeSummary);
  if (result.errors.length) {
    for (const error of result.errors) console.error(`native-state: ${error}`);
    process.exit(1);
  }
  if (!result.wrote && !result.statusText) {
    console.log(
      "native-state: the generated trees are tracked and at their blessed ids, the inputs are what the ratchet reads, and both fingerprints agree"
    );
  }
}
