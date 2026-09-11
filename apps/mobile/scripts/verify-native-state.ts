#!/usr/bin/env node
/**
 * Native input purity + identity ratchet for apps/mobile (#587 E23, #646;
 * rebuilt for Continuous Native Generation in #996).
 *
 * `ios/` and `android/` are prebuild OUTPUTS and are gitignored, so the gate no
 * longer reads a committed Podfile.lock or a committed Xcode project — there is
 * none, and the checks that did (pod-lock completeness, pod version coherence,
 * REACT_NATIVE_PATH hygiene) protected a reviewable artifact that no longer
 * exists. `pod install` now runs only inside the macOS lanes that prebuild
 * first, against a lock those lanes generate and discard, so there is nothing
 * left for a repo-wide checker to compare it to.
 *
 * What is left is the same invariant with its current subject: the inputs are
 * the whole recipe, and the recipe is reproducible.
 *
 * Layers (fail-closed; L1-L3 must pass before fingerprints may be written):
 *   L1 generated-tree purity — nothing under ios/ or android/ is tracked, and
 *     both are ignored by git
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

import { fingerprintReportForPlatform } from "./native-fingerprint.ts";
import {
  attachRemediation,
  formatStatusReport,
  formatWriteSummary,
  parseNativeStateArgs,
  validateFingerprintInputCoverage,
  validateFingerprints,
  validateGeneratedTreesNotHashed,
  validateGeneratedTreesUntracked,
  validateModulePlatformShape,
  FIX_INPUTS_HINT,
  GENERATED_NATIVE_DIRS,
} from "./verify-native-state-lib.ts";

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
  validateGeneratedTreesUntracked,
  validateModulePlatformShape,
  WRITE_CMD,
  FIX_INPUTS_HINT,
  GENERATED_NATIVE_DIRS,
} from "./verify-native-state-lib.ts";

const mobileRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(mobileRoot, "..", "..");

/**
 * The tracked half of L1, asked of git rather than of the filesystem: the
 * question is what the INDEX carries, and a prebuilt worktree answers it wrong.
 */
export function trackedGeneratedNativeFiles(cwd = repoRoot): string[] {
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
 * exclude file.
 *
 * The path is queried WITH a trailing slash, and that is load-bearing: the rule
 * is `/ios/`, which matches directories only, and `git check-ignore` cannot tell
 * that a bare `apps/mobile/ios` names a directory when the directory is absent.
 * On a fresh checkout — the state this gate must be green in — the bare form
 * answers "not ignored" and the trailing-slash form answers correctly in both
 * states. `--no-index` so the answer is the RULE's, independent of whether
 * anything happens to be tracked; the tracked half is a separate check.
 */
export function generatedNativeDirsIgnored(
  cwd = repoRoot
): Record<string, boolean> {
  const ignored: Record<string, boolean> = {};
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

/** Repo-owned config plugins, mobile-root-relative (the fingerprint's units). */
export async function discoverConfigPlugins(
  pluginsRoot = path.join(mobileRoot, "plugins")
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(pluginsRoot);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
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
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
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
        const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
        const config =
          typeof parsed === "object" && parsed !== null
            ? (parsed as {
                platforms?: unknown;
                ios?: unknown;
                android?: unknown;
              })
            : null;
        return {
          moduleId: entry.name,
          config,
          hasIosDir,
          hasAndroidDir,
          missingConfig: false,
        };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
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

async function dirExists(dir: string): Promise<boolean> {
  try {
    await readdir(dir);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}

/** The per-platform module directories autolinking is expected to have found. */
export function moduleNativeDirsFor(
  platform: "ios" | "android",
  modulePlatforms: {
    moduleId: string;
    hasIosDir: boolean;
    hasAndroidDir: boolean;
  }[]
): string[] {
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
  modulePlatforms,
  pluginFiles,
  reports,
}: {
  trackedNativeFiles: string[];
  ignoredDirs: Record<string, boolean>;
  modulePlatforms: {
    moduleId: string;
    config: { platforms?: unknown; ios?: unknown; android?: unknown } | null;
    hasIosDir: boolean;
    hasAndroidDir: boolean;
    missingConfig: boolean;
  }[];
  pluginFiles: string[];
  reports: {
    platform: "ios" | "android";
    sources: { filePath?: string; id?: string; hash?: string | null }[];
  }[];
}): string[] {
  const errors: string[] = [
    ...validateGeneratedTreesUntracked({ trackedNativeFiles, ignoredDirs }),
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

export async function verifyNativeState(
  options: { write?: boolean; status?: boolean } = {}
) {
  const { write = false, status = false } = options;
  const [expected, pluginFiles, modulePlatforms, ...reports] =
    await Promise.all([
      readJson(path.join(mobileRoot, "native-fingerprints.json")),
      discoverConfigPlugins(),
      loadLocalModulePlatforms(),
      ...(["ios", "android"] as const).map(async (platform) => ({
        platform,
        ...(await fingerprintReportForPlatform(platform)),
      })),
    ]);

  const inputErrors = collectInputErrors({
    trackedNativeFiles: trackedGeneratedNativeFiles(),
    ignoredDirs: generatedNativeDirsIgnored(),
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

  if (write && inputErrors.length > 0) {
    return {
      errors: attachRemediation(inputErrors),
      wrote: false,
      statusText: status
        ? formatStatusReport({
            errors: inputErrors,
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
        "Expected @expo/fingerprint hashes over the CNG inputs (app.config.ts, plugins/, modules/, the dependency set). Changing them must be a reviewed act — see docs/traps/mobile-native-state.md.",
      ios: String(actualByPlatform.ios ?? ""),
      android: String(actualByPlatform.android ?? ""),
    };
    const platformsMoved = (["ios", "android"] as const).filter(
      (p) => expected[p] !== next[p]
    );
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
            fingerprints: {
              expected: next,
              actual: actualByPlatform,
            },
          })
        : null,
      writeSummary: formatWriteSummary({
        previous: expected as Record<string, string | undefined>,
        next,
        inputInventory,
        platformsMoved,
      }),
      inputInventory,
      fingerprints: { expected: next, actual: actualByPlatform },
    };
  }

  const identityErrors = validateFingerprints(
    expected as Record<string, string | undefined>,
    actualByPlatform
  );
  return {
    errors: attachRemediation([...inputErrors, ...identityErrors]),
    wrote: false,
    statusText: status
      ? formatStatusReport({
          errors: [...inputErrors, ...identityErrors],
          inputInventory,
          fingerprints: {
            expected: expected as Record<string, string | undefined>,
            actual: actualByPlatform,
          },
        })
      : null,
    writeSummary: null,
    inputInventory,
    fingerprints: { expected, actual: actualByPlatform },
  };
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${file} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  let flags;
  try {
    flags = parseNativeStateArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `native-state: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(2);
  }
  if (flags.help) {
    console.log(`usage: verify-native-state.ts [--status] [--write]
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
      "native-state: ios/ and android/ are untracked outputs, the inputs are what the ratchet reads, and both fingerprints agree"
    );
  }
}
