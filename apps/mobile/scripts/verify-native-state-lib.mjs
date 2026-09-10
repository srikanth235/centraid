/**
 * Pure validators and formatters for native-state L1–L4 (#646, rebuilt for CNG
 * in #996). Kept free of project I/O so unit tests can drive fixtures without
 * the CLI.
 *
 * The layers changed subject when `ios/` and `android/` stopped being committed.
 * The INVARIANT did not: an incomplete or unreproducible native recipe must not
 * be blessed. What used to be "the committed native tree agrees with the config"
 * is now "the config, the plugins and the local modules are the ONLY native
 * inputs, and a fresh prebuild is reproducible from them alone".
 */

export const WRITE_CMD = "bun run --cwd apps/mobile ci:native-state --write";
export const FIX_INPUTS_HINT =
  "fix the native inputs first (app.config.ts, plugins/, modules/), then re-run verify; do not run --write until L1–L3 pass";
/** The two generated trees, repo-relative. Nothing under them may be tracked. */
export const GENERATED_NATIVE_DIRS = ["apps/mobile/ios", "apps/mobile/android"];

/**
 * L1 generated-tree purity — the regression guard that replaces every check
 * that used to read a committed native file.
 *
 * A tracked file under `ios/` or `android/` is not a small mistake: prebuild
 * overwrites it on the next run, so it is an edit that appears to work, ships
 * once, and vanishes. It also re-introduces exactly the drift L1–L3 used to
 * chase, because a committed generated file has no writer that keeps it current.
 *
 * Two halves, because either alone is bypassable: the tracked-file list catches
 * a `git add -f`, and the ignore assertion catches a `.gitignore` edit that
 * would let the next `git add .` sweep the whole tree back in.
 *
 * @param {{trackedNativeFiles: string[], ignoredDirs: Record<string, boolean>}} input the git-answered index and ignore state for the two generated trees
 */
export function validateGeneratedTreesUntracked({
  trackedNativeFiles,
  ignoredDirs,
}) {
  const errors = [];
  const tracked = [...trackedNativeFiles].sort();
  if (tracked.length > 0) {
    const shown = tracked.slice(0, 5).join(", ");
    const more = tracked.length > 5 ? `, +${tracked.length - 5} more` : "";
    errors.push(
      `L1 generated tree: ${tracked.length} tracked file(s) under the prebuild outputs (${shown}${more}). ios/ and android/ are generated; a file that must survive a regeneration is a file a config plugin writes (${FIX_INPUTS_HINT})`
    );
  }
  for (const dir of GENERATED_NATIVE_DIRS) {
    if (ignoredDirs[dir] !== true) {
      errors.push(
        `L1 generated tree: ${dir} is not ignored by git — the next \`git add .\` would commit a prebuild output (${FIX_INPUTS_HINT})`
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
    "  L1 generated-tree purity (nothing under ios/ or android/ is tracked or unignored)",
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
