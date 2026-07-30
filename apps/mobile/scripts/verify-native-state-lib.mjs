/**
 * Pure validators and formatters for native-state L1–L4 (#646).
 * Kept free of project I/O so unit tests can drive fixtures without the CLI.
 */
import path from "node:path";

export const WRITE_CMD = "bun run --cwd apps/mobile ci:native-state --write";
export const FIX_RECIPE_HINT =
  "fix the native recipe first (complete Podfile.lock / module configs), then re-run verify; do not run --write until L1–L3 pass";
export const MACOS_POD_INSTALL =
  "cd apps/mobile/ios && pod install  # macOS only; Linux CI can verify but not repair the lock";

const podsRootVariable = ["$", "{PODS_ROOT}"].join("");

export function podVersions(lock) {
  const version = (name) => {
    const match = new RegExp(
      `^  - ${name} \\((?<version>[^)]+)\\):?$`,
      "mu"
    ).exec(lock);
    return match?.groups?.version ?? null;
  };
  return {
    expo: version("Expo"),
    reactNative: version("React-Core"),
    reactNativePrebuilt: version("React-Core-prebuilt"),
    reactNativeDependencies: version("ReactNativeDependencies"),
    hermesTag:
      /^ {4}:tag: (?<tag>hermes-v\S+)$/mu.exec(lock)?.groups?.tag ?? null,
  };
}

export function validatePodLock({
  lock,
  expoVersion,
  reactNativeVersion,
  hermesTags,
}) {
  const actual = podVersions(lock);
  const errors = [];
  if (actual.expo !== expoVersion) {
    errors.push(
      `Podfile.lock Expo ${actual.expo ?? "missing"} does not match node_modules Expo ${expoVersion}`
    );
  }
  if (actual.reactNative !== reactNativeVersion) {
    errors.push(
      `Podfile.lock React-Core ${actual.reactNative ?? "missing"} does not match node_modules react-native ${reactNativeVersion}`
    );
  }
  if (actual.reactNativePrebuilt !== reactNativeVersion) {
    errors.push(
      `Podfile.lock React-Core-prebuilt ${actual.reactNativePrebuilt ?? "missing"} does not match node_modules react-native ${reactNativeVersion}`
    );
  }
  if (actual.reactNativeDependencies !== reactNativeVersion) {
    errors.push(
      `Podfile.lock ReactNativeDependencies ${actual.reactNativeDependencies ?? "missing"} does not match node_modules react-native ${reactNativeVersion}`
    );
  }
  if (!actual.hermesTag || !hermesTags.includes(actual.hermesTag)) {
    errors.push(
      `Podfile.lock Hermes tag ${actual.hermesTag ?? "missing"} does not match node_modules react-native Hermes tag(s) ${hermesTags.join(", ") || "missing"}`
    );
  }
  return errors;
}

export function validateReactNativePaths(project, { podsRoot, expected }) {
  const errors = [];
  const matches = project.matchAll(
    /REACT_NATIVE_PATH = "(?<configured>[^"]+)"/gu
  );
  for (const match of matches) {
    const configured = match.groups?.configured ?? "";
    if (path.isAbsolute(configured)) {
      errors.push(
        `REACT_NATIVE_PATH must not encode an absolute machine path: ${configured}`
      );
      continue;
    }
    const expanded = configured.replace(podsRootVariable, podsRoot);
    const resolved = path.resolve(expanded);
    if (resolved !== expected) {
      errors.push(
        `REACT_NATIVE_PATH resolves to ${resolved}; expected ${expected} from this repository layout`
      );
    }
  }
  if (!project.includes("REACT_NATIVE_PATH =")) {
    errors.push("project.pbxproj has no REACT_NATIVE_PATH to validate");
  }
  return errors;
}

export function validateFingerprints(expected, actualByPlatform) {
  const errors = [];
  for (const platform of ["ios", "android"]) {
    const actual = actualByPlatform[platform];
    if (expected[platform] !== actual) {
      errors.push(
        `${platform} native fingerprint mismatch: committed ${expected[platform] ?? "missing"}, current ${actual}; review the native diff and run \`${WRITE_CMD}\` only after L1–L3 are green`
      );
    }
  }
  return errors;
}

/** Body of a top-level Podfile.lock section (DEPENDENCIES, EXTERNAL SOURCES, …). */
export function lockSectionBody(lock, sectionName) {
  const header = `${sectionName}:\n`;
  const start = lock.indexOf(header);
  if (start < 0) return "";
  const rest = lock.slice(start + header.length);
  // Next top-level heading is a non-indented non-empty line (PODS-style ALL CAPS / words).
  const next = rest.search(/^[A-Za-z]/mu);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Pod names declared under Podfile.lock DEPENDENCIES (bare name before space/paren). */
export function dependencyPodNames(lock) {
  const section = lockSectionBody(lock, "DEPENDENCIES");
  if (!section) return [];
  const names = [];
  for (const line of section.split("\n")) {
    const match = /^ {2}- "?(?<name>[A-Za-z0-9._-]+)/u.exec(line);
    if (match?.groups?.name) names.push(match.groups.name);
  }
  return names;
}

/** Pod names with EXTERNAL SOURCES entries (path/git pods). */
export function externalSourcePodNames(lock) {
  const section = lockSectionBody(lock, "EXTERNAL SOURCES");
  if (!section) return [];
  const names = [];
  for (const line of section.split("\n")) {
    const match = /^ {2}(?<name>[A-Za-z0-9._-]+):\s*$/u.exec(line);
    if (match?.groups?.name) names.push(match.groups.name);
  }
  return names;
}

/**
 * L1 iOS: every local modules/<name>/ios/<Name>.podspec basename (minus .podspec)
 * must appear in both DEPENDENCIES and EXTERNAL SOURCES.
 */
export function validateIosModuleLockCompleteness({ localPodNames, lock }) {
  const deps = new Set(dependencyPodNames(lock));
  const external = new Set(externalSourcePodNames(lock));
  const errors = [];
  for (const name of [...localPodNames].sort()) {
    if (!deps.has(name)) {
      errors.push(
        `L1 recipe incomplete: local module pod ${name} is missing from Podfile.lock DEPENDENCIES (${MACOS_POD_INSTALL}; ${FIX_RECIPE_HINT})`
      );
    }
    if (!external.has(name)) {
      errors.push(
        `L1 recipe incomplete: local module pod ${name} is missing from Podfile.lock EXTERNAL SOURCES (${MACOS_POD_INSTALL}; ${FIX_RECIPE_HINT})`
      );
    }
  }
  return errors;
}

/**
 * L1 Android depth limit: each module's expo-module.config.json must declare
 * every platform its on-disk directories imply. No committed Android lock —
 * ci:android-native compilation is the real Android completeness gate.
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
      `L1 Android/shape: module ${moduleId} has an ios/ directory but expo-module.config.json platforms omit "ios" (${FIX_RECIPE_HINT})`
    );
  }
  if (hasAndroidDir && !platforms.includes("android")) {
    errors.push(
      `L1 Android/shape: module ${moduleId} has an android/ directory but expo-module.config.json platforms omit "android" (${FIX_RECIPE_HINT})`
    );
  }
  if (platforms.includes("ios") && config?.ios == null) {
    errors.push(
      `L1 Android/shape: module ${moduleId} lists platform "ios" but has no ios config block (${FIX_RECIPE_HINT})`
    );
  }
  if (platforms.includes("android") && config?.android == null) {
    errors.push(
      `L1 Android/shape: module ${moduleId} lists platform "android" but has no android config block (${FIX_RECIPE_HINT})`
    );
  }
  return errors;
}

/** Classify a free-text error into L1–L4 for --status presentation. */
export function classifyNativeStateError(message) {
  if (
    message.startsWith("L1 ") ||
    message.includes("L1 recipe") ||
    message.includes("L1 Android/shape")
  ) {
    return "L1";
  }
  if (
    message.startsWith("Podfile.lock Expo") ||
    message.startsWith("Podfile.lock React-Core") ||
    message.startsWith("Podfile.lock ReactNativeDependencies") ||
    message.startsWith("Podfile.lock Hermes")
  ) {
    return "L2";
  }
  if (
    message.includes("REACT_NATIVE_PATH") ||
    message.includes("project.pbxproj")
  ) {
    return "L3";
  }
  if (message.includes("native fingerprint mismatch")) {
    return "L4";
  }
  return "L?";
}

export function attachRemediation(errors) {
  if (errors.length === 0) return errors;
  const layers = new Set(errors.map(classifyNativeStateError));
  const hasRecipeOrCoherence = [...layers].some((l) =>
    ["L1", "L2", "L3"].includes(l)
  );
  const hasIdentityOnly =
    layers.has("L4") && !hasRecipeOrCoherence && layers.size === 1;
  const hasIdentityWithRecipe = layers.has("L4") && hasRecipeOrCoherence;

  if (hasIdentityOnly) {
    return [
      ...errors,
      `next: run \`${WRITE_CMD}\` after reviewing the native diff (L4 identity only)`,
    ];
  }
  if (hasIdentityWithRecipe || hasRecipeOrCoherence) {
    return [
      ...errors,
      `next: ${FIX_RECIPE_HINT}${hasIdentityWithRecipe ? `; only then \`${WRITE_CMD}\`` : ""}`,
    ];
  }
  return errors;
}

export function moduleLockDelta({ localPodNames, lock }) {
  const deps = new Set(dependencyPodNames(lock));
  const present = [];
  const missing = [];
  for (const name of [...localPodNames].sort()) {
    if (deps.has(name)) present.push(name);
    else missing.push(name);
  }
  return { present, missing };
}

export function formatStatusReport({ errors, moduleDelta, fingerprints }) {
  const byLayer = { L1: [], L2: [], L3: [], L4: [], "L?": [] };
  for (const error of errors) {
    byLayer[classifyNativeStateError(error)].push(error);
  }
  const lines = [
    "native-state status:",
    "  L1 recipe completeness (local modules ↔ Podfile.lock; Android config shape)",
    "  L2 pod version coherence (Expo / React-Core / Hermes vs node_modules)",
    "  L3 path hygiene (REACT_NATIVE_PATH)",
    "  L4 identity ratchet (native-fingerprints.json vs @expo/fingerprint)",
    "",
  ];
  if (moduleDelta) {
    lines.push(
      `  module↔lock: present [${moduleDelta.present.join(", ") || "none"}]; missing [${moduleDelta.missing.join(", ") || "none"}]`
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
    lines.push("  overall: green — recipe complete and identity agrees");
  } else {
    lines.push("  overall: red — see remediation in error lines above");
  }
  return lines.join("\n");
}

export function formatWriteSummary({
  previous,
  next,
  moduleDelta,
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
    `  module↔lock delta validated: present [${moduleDelta.present.join(", ")}]; missing [${moduleDelta.missing.join(", ") || "none"}]`,
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
