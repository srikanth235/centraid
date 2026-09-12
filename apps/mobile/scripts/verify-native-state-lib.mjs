/**
 * Pure validators and formatters for native-state L1–L4 (#646, rebuilt for CNG
 * in #996). Kept free of project I/O so unit tests can drive fixtures without
 * the CLI.
 *
 * The layers changed subject twice, and the INVARIANT never did: an incomplete
 * or unreproducible native recipe must not be blessed. #996 made `ios/` and
 * `android/` gitignored outputs, so L1 asked that nothing under them be
 * tracked. #1011 generates the projects and TRACKS them, so the diff of a
 * native change is reviewable, and L1 asks the question that fits a tracked
 * generated tree: does it still match what prebuild writes (R-NY-17, #1015)?
 * Absence is no longer the property — DRIFT is.
 */

export const WRITE_CMD = "bun run --cwd apps/mobile ci:native-state --write";
export const FIX_INPUTS_HINT =
  "fix the native inputs first (app.config.ts, plugins/, modules/), then re-run verify; do not run --write until L1–L3 pass";
/** The two generated trees, repo-relative. Tracked, and regenerated (#1011). */
export const GENERATED_NATIVE_DIRS = ["apps/mobile/ios", "apps/mobile/android"];

/**
 * The blessed git tree object of each generated tree, as `native-fingerprints`
 * records it beside the input hashes. A git tree id IS the content of the
 * directory: one byte changed anywhere under it changes the id, and nothing
 * else does — no walk, no hashing of our own, and no list of files to keep
 * current as prebuild's output grows.
 */
export const GENERATED_TREE_KEY = "trees";

/**
 * L1 generated-tree fidelity — the regression guard over a TRACKED generated
 * tree (#1011, R-NY-17).
 *
 * Three failures, and each is silent in its own way.
 *
 * **The tree leaves the index.** A generated tree that is tracked is a tree
 * whose every regeneration arrives as a reviewable diff; one that is ignored,
 * or absent from the index, takes that review away and takes every native
 * change with it. So both halves are asserted, and the ignore half matters
 * MORE now than it did when the tree was an output: a `.gitignore` rule over a
 * tracked tree is the worst of both — the files are committed and the next
 * regeneration never shows up in `git status`.
 *
 * **The tree is hand-edited.** The old failure, with a new shape. A tracked
 * generated file can now be edited and committed and it will survive — until
 * the next prebuild silently reverts it, with no error anywhere. The edit
 * belongs in `app.config.ts`, a config plugin, or a local module; nothing
 * else writes these trees.
 *
 * **The tree falls behind its inputs.** An input moves, nobody regenerates,
 * and the committed projects describe an app that no longer exists.
 *
 * The first is answered by git's index and ignore rules; the second and third
 * by the tree's git object id, recorded beside the input fingerprints and
 * moved only by a reviewed `--write`.
 *
 * @param {{trackedNativeFiles: string[], ignoredDirs: Record<string, boolean>}} input the git-answered index and ignore state for the two generated trees
 */
export function validateGeneratedTreesTracked({
  trackedNativeFiles,
  ignoredDirs,
}) {
  const errors = [];
  for (const dir of GENERATED_NATIVE_DIRS) {
    if (!trackedNativeFiles.some((file) => file.startsWith(`${dir}/`))) {
      errors.push(
        `L1 generated tree: ${dir} has no tracked file — the generated projects are committed (#1011) so every regeneration is a reviewable diff (${FIX_INPUTS_HINT})`
      );
    }
    if (ignoredDirs[dir] === true) {
      errors.push(
        `L1 generated tree: ${dir} is ignored by git while its files are tracked — the next prebuild's changes would never reach \`git status\` (${FIX_INPUTS_HINT})`
      );
    }
  }
  return errors;
}

/**
 * L1 drift — the committed tree's git object id against the blessed one.
 *
 * The comparison is the whole point: `expected` is what was blessed the last
 * time someone reviewed a regeneration, `actual` is what the index carries now.
 * A hand-edit under the tree moves `actual` and nothing else does, so the error
 * names the tree rather than guessing which file.
 *
 * A tree with no recorded id is a FINDING, not a pass: a missing entry is
 * exactly what a ratchet going quiet looks like.
 *
 * @param {Record<string, string|undefined>} expected blessed tree ids, by repo-relative dir
 * @param {Record<string, string|undefined>} actual the ids the index carries now
 */
export function validateGeneratedTreeDrift(expected, actual) {
  const errors = [];
  for (const dir of GENERATED_NATIVE_DIRS) {
    const was = expected?.[dir];
    const now = actual?.[dir];
    if (was === undefined) {
      errors.push(
        `L1 generated tree drift: ${dir} has no blessed tree id in native-fingerprints.json — a tree nobody recorded is a tree nothing is watching (${FIX_INPUTS_HINT})`
      );
      continue;
    }
    if (now === undefined) {
      errors.push(
        `L1 generated tree drift: ${dir} is not a tree in the index — it was blessed at ${was} (${FIX_INPUTS_HINT})`
      );
      continue;
    }
    if (was !== now) {
      errors.push(
        `L1 generated tree drift: ${dir} drifted — blessed ${was}, now ${now}. Regenerate with \`bun run --cwd apps/mobile native:prebuild\` and review the diff; a hand-edit belongs in app.config.ts, a plugin, or a local module (${FIX_INPUTS_HINT})`
      );
    }
  }
  return errors;
}

/**
 * L2 input coverage — the ratchet must actually be keyed on the inputs it
 * claims to key on.
 *
 * A fingerprint that silently stops reading a config plugin or a local module
 * does not go red; it goes QUIET, which is worse. It keeps matching the
 * committed hash while the thing it is supposed to notice changes freely — the
 * exact shape of the #638 hole, one layer up from the file it used to live in.
 * So the source list `@expo/fingerprint` produced is asserted against the input
 * inventory read off disk.
 *
 * @param {{platform: "ios"|"android", sources: {type: string, filePath?: string, id?: string}[], pluginFiles: string[], moduleNativeDirs: string[]}} input the fingerprint's source list and the input inventory read off disk
 */
export function validateFingerprintInputCoverage({
  platform,
  sources,
  pluginFiles,
  moduleNativeDirs,
}) {
  const filePaths = new Set(
    sources.map((source) => source.filePath).filter(Boolean)
  );
  const ids = new Set(sources.map((source) => source.id).filter(Boolean));
  const errors = [];
  for (const plugin of [...pluginFiles].sort()) {
    if (!filePaths.has(plugin)) {
      errors.push(
        `L2 input coverage: config plugin ${plugin} is not in the ${platform} fingerprint source list — the ratchet cannot notice a change to it (${FIX_INPUTS_HINT})`
      );
    }
  }
  for (const dir of [...moduleNativeDirs].sort()) {
    if (!filePaths.has(dir)) {
      errors.push(
        `L2 input coverage: local module directory ${dir} is not in the ${platform} fingerprint source list — autolinking is not seeing it (${FIX_INPUTS_HINT})`
      );
    }
  }
  // `app.config.ts` never appears as a file: Expo resolves it and folds the
  // result into these two synthetic sources. Their absence means the ratchet
  // has stopped reading the config and the plugin list entirely.
  for (const id of ["expoConfig", `expoAutolinkingConfig:${platform}`]) {
    if (!ids.has(id)) {
      errors.push(
        `L2 input coverage: the ${platform} fingerprint carries no \`${id}\` source — app.config.ts and the plugin list are not being read (${FIX_INPUTS_HINT})`
      );
    }
  }
  return errors;
}

/**
 * L3 host independence — the committed hash must be reproducible on a machine
 * that has never run a prebuild.
 *
 * Under CNG `apps/mobile/ios` exists on a developer's disk and does not exist on
 * a fresh CI checkout, so any source that hashes CONTENT from inside those trees
 * makes the ratchet host-stateful: it would go red on whichever of the two ran
 * second, and no edit would fix it. `nativeFingerprintOptions` ignores both
 * trees, which leaves `@expo/fingerprint`'s `bareNativeDir` source present but
 * empty (`hash: null`) — the same value it takes when the directory is absent.
 * This asserts that emptiness rather than the ignore-path list, so deleting the
 * ignore entry fails here instead of quietly making every hash local.
 *
 * @param {{platform: "ios"|"android", sources: {filePath?: string, hash?: string|null}[]}} input the fingerprint's source list, each entry carrying the hash it contributed
 */
export function validateGeneratedTreesNotHashed({ platform, sources }) {
  const errors = [];
  for (const source of sources) {
    const filePath = source.filePath ?? "";
    const insideGenerated =
      filePath === "ios" ||
      filePath === "android" ||
      filePath.startsWith("ios/") ||
      filePath.startsWith("android/");
    if (insideGenerated && source.hash != null) {
      errors.push(
        `L3 host independence: the ${platform} fingerprint hashes ${filePath}, a prebuild output. A machine that has not prebuilt would compute a different hash, so the ratchet could never settle (${FIX_INPUTS_HINT})`
      );
    }
  }
  return errors;
}

/**
 * L2 module shape: each local module's expo-module.config.json must declare
 * every platform its on-disk directories imply. Autolinking reads the config,
 * not the directories, so an undeclared `android/` is a native module that is
 * silently absent from the generated project rather than a build error.
 */
export function validateModulePlatformShape({
  moduleId,
  config,
  hasIosDir,
  hasAndroidDir,
}) {
  const platforms = Array.isArray(config?.platforms) ? config.platforms : [];
  const errors = [];
  if (hasIosDir && !platforms.includes("ios")) {
    errors.push(
      `L2 module shape: module ${moduleId} has an ios/ directory but expo-module.config.json platforms omit "ios" (${FIX_INPUTS_HINT})`
    );
  }
  if (hasAndroidDir && !platforms.includes("android")) {
    errors.push(
      `L2 module shape: module ${moduleId} has an android/ directory but expo-module.config.json platforms omit "android" (${FIX_INPUTS_HINT})`
    );
  }
  if (platforms.includes("ios") && config?.ios == null) {
    errors.push(
      `L2 module shape: module ${moduleId} lists platform "ios" but has no ios config block (${FIX_INPUTS_HINT})`
    );
  }
  if (platforms.includes("android") && config?.android == null) {
    errors.push(
      `L2 module shape: module ${moduleId} lists platform "android" but has no android config block (${FIX_INPUTS_HINT})`
    );
  }
  return errors;
}

/** L4 identity ratchet: committed hashes vs what the inputs currently produce. */
export function validateFingerprints(expected, actualByPlatform) {
  const errors = [];
  for (const platform of ["ios", "android"]) {
    const actual = actualByPlatform[platform];
    if (expected[platform] !== actual) {
      errors.push(
        `${platform} native fingerprint mismatch: committed ${expected[platform] ?? "missing"}, current ${actual}; review the input diff and run \`${WRITE_CMD}\` only after L1–L3 are green`
      );
    }
  }
  return errors;
}

/** Classify a free-text error into L1–L4 for --status presentation. */
export function classifyNativeStateError(message) {
  if (message.startsWith("L1 ")) return "L1";
  if (message.startsWith("L2 ")) return "L2";
  if (message.startsWith("L3 ")) return "L3";
  if (message.includes("native fingerprint mismatch")) return "L4";
  return "L?";
}

export function attachRemediation(errors) {
  if (errors.length === 0) return errors;
  const layers = new Set(errors.map(classifyNativeStateError));
  const hasInputProblem = ["L1", "L2", "L3"].some((layer) => layers.has(layer));
  const hasIdentity = layers.has("L4");

  if (hasIdentity && !hasInputProblem && layers.size === 1) {
    return [
      ...errors,
      `next: run \`${WRITE_CMD}\` after reviewing the input diff (L4 identity only)`,
    ];
  }
  if (hasInputProblem) {
    return [
      ...errors,
      `next: ${FIX_INPUTS_HINT}${hasIdentity ? `; only then \`${WRITE_CMD}\`` : ""}`,
    ];
  }
  return errors;
}

export function formatStatusReport({ errors, inputInventory, fingerprints }) {
  const byLayer = { L1: [], L2: [], L3: [], L4: [], "L?": [] };
  for (const error of errors) {
    byLayer[classifyNativeStateError(error)].push(error);
  }
  const lines = [
    "native-state status:",
    "  L1 generated-tree fidelity (ios/ and android/ are tracked, unignored, and at their blessed tree ids)",
    "  L2 input coverage (config plugins + local modules are what the fingerprint reads)",
    "  L3 host independence (no prebuild output contributes to the hash)",
    "  L4 identity ratchet (native-fingerprints.json vs @expo/fingerprint)",
    "",
  ];
  if (inputInventory) {
    lines.push(
      `  inputs: plugins [${inputInventory.pluginFiles.join(", ") || "none"}]; modules [${inputInventory.modules.join(", ") || "none"}]`
    );
  }
  if (fingerprints) {
    lines.push(
      `  fingerprints: ios committed=${fingerprints.expected.ios ?? "missing"} actual=${fingerprints.actual.ios ?? "n/a"}; android committed=${fingerprints.expected.android ?? "missing"} actual=${fingerprints.actual.android ?? "n/a"}`
    );
  }
  lines.push("");
  for (const layer of ["L1", "L2", "L3", "L4", "L?"]) {
    const items = byLayer[layer];
    if (items.length === 0) {
      if (layer !== "L?") lines.push(`  ${layer}: ok`);
      continue;
    }
    lines.push(`  ${layer}: FAIL (${items.length})`);
    for (const item of items) lines.push(`    - ${item}`);
  }
  if (errors.length === 0) {
    lines.push(
      "  overall: green — inputs are the only recipe and identity agrees"
    );
  } else {
    lines.push("  overall: red — see remediation in error lines above");
  }
  return lines.join("\n");
}

export function formatWriteSummary({
  previous,
  next,
  inputInventory,
  platformsMoved,
}) {
  const moved =
    platformsMoved.length > 0
      ? platformsMoved.join(", ")
      : "none (hashes unchanged)";
  return [
    "native-state --write: fingerprints updated",
    `  platforms moved: ${moved}`,
    `  ios: ${previous.ios ?? "missing"} → ${next.ios}`,
    `  android: ${previous.android ?? "missing"} → ${next.android}`,
    `  inputs validated: plugins [${inputInventory.pluginFiles.join(", ")}]; modules [${inputInventory.modules.join(", ")}]`,
  ].join("\n");
}

export function parseNativeStateArgs(argv) {
  const flags = { write: false, status: false };
  for (const arg of argv) {
    if (arg === "--write") flags.write = true;
    else if (arg === "--status") flags.status = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  return flags;
}
