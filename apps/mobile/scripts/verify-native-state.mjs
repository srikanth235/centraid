#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fingerprintForPlatform } from "./native-fingerprint.mjs";
import {
  attachRemediation,
  formatStatusReport,
  formatWriteSummary,
  moduleLockDelta,
  parseNativeStateArgs,
  validateFingerprints,
  validateIosModuleLockCompleteness,
  validateModulePlatformShape,
  validatePodLock,
  validateReactNativePaths,
  FIX_RECIPE_HINT,
} from "./verify-native-state-lib.mjs";

export {
  attachRemediation,
  classifyNativeStateError,
  dependencyPodNames,
  externalSourcePodNames,
  formatStatusReport,
  formatWriteSummary,
  lockSectionBody,
  moduleLockDelta,
  parseNativeStateArgs,
  podVersions,
  validateFingerprints,
  validateIosModuleLockCompleteness,
  validateModulePlatformShape,
  validatePodLock,
  validateReactNativePaths,
  WRITE_CMD,
  FIX_RECIPE_HINT,
  MACOS_POD_INSTALL,
} from "./verify-native-state-lib.mjs";

const mobileRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(mobileRoot, "..", "..");

export async function discoverLocalPodNames(
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
  const perDir = await Promise.all(
    dirs.map(async (entry) => {
      const iosDir = path.join(modulesRoot, entry.name, "ios");
      try {
        const iosEntries = await readdir(iosDir);
        return iosEntries
          .filter((file) => file.endsWith(".podspec"))
          .map((file) => file.replace(/\.podspec$/u, ""));
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT")
          return [];
        throw error;
      }
    })
  );
  return perDir.flat().sort();
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
      try {
        const config = JSON.parse(await readFile(configPath, "utf8"));
        const [hasIosDir, hasAndroidDir] = await Promise.all([
          dirExists(path.join(moduleRoot, "ios")),
          dirExists(path.join(moduleRoot, "android")),
        ]);
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
            hasIosDir: false,
            hasAndroidDir: false,
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

export async function collectRecipeErrors(inputs) {
  const {
    lock,
    project,
    expoVersion,
    reactNativeVersion,
    hermesTags,
    localPodNames,
    modulePlatforms,
    podsRoot,
    expectedReactNativePath,
  } = inputs;

  const errors = [
    ...validateIosModuleLockCompleteness({ localPodNames, lock }),
  ];
  for (const mod of modulePlatforms) {
    if (mod.missingConfig || mod.config == null) {
      errors.push(
        `L1 Android/shape: module ${mod.moduleId} is missing expo-module.config.json (${FIX_RECIPE_HINT})`
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
  errors.push(
    ...validatePodLock({
      lock,
      expoVersion,
      reactNativeVersion,
      hermesTags,
    }),
    ...validateReactNativePaths(project, {
      podsRoot,
      expected: expectedReactNativePath,
    })
  );
  return errors;
}

export async function verifyNativeState(options = {}) {
  const { write = false, status = false } = options;
  const [
    expected,
    lock,
    project,
    expoPackage,
    reactNativePackage,
    hermesTag,
    hermesV1Tag,
    localPodNames,
    modulePlatforms,
  ] = await Promise.all([
    readJson(path.join(mobileRoot, "native-fingerprints.json")),
    readFile(path.join(mobileRoot, "ios", "Podfile.lock"), "utf8"),
    readFile(
      path.join(mobileRoot, "ios", "Centraid.xcodeproj", "project.pbxproj"),
      "utf8"
    ),
    readJson(path.join(repoRoot, "node_modules", "expo", "package.json")),
    readJson(
      path.join(repoRoot, "node_modules", "react-native", "package.json")
    ),
    readOptionalLine(
      path.join(
        repoRoot,
        "node_modules",
        "react-native",
        "sdks",
        ".hermesversion"
      )
    ),
    readOptionalLine(
      path.join(
        repoRoot,
        "node_modules",
        "react-native",
        "sdks",
        ".hermesv1version"
      )
    ),
    discoverLocalPodNames(),
    loadLocalModulePlatforms(),
  ]);

  const recipeErrors = await collectRecipeErrors({
    lock,
    project,
    expoVersion: expoPackage.version,
    reactNativeVersion: reactNativePackage.version,
    hermesTags: [hermesTag, hermesV1Tag].filter(Boolean),
    localPodNames,
    modulePlatforms,
    podsRoot: path.join(mobileRoot, "ios", "Pods"),
    expectedReactNativePath: path.join(
      repoRoot,
      "node_modules",
      "react-native"
    ),
  });

  const moduleDelta = moduleLockDelta({ localPodNames, lock });

  if (write && recipeErrors.length > 0) {
    const errors = attachRemediation(recipeErrors);
    return {
      errors,
      wrote: false,
      statusText: status
        ? formatStatusReport({
            errors: recipeErrors,
            moduleDelta,
            fingerprints: null,
          })
        : null,
      writeSummary: null,
      moduleDelta,
    };
  }

  const fingerprints = await Promise.all(
    ["ios", "android"].map(async (platform) => ({
      platform,
      actual: await fingerprintForPlatform(platform),
    }))
  );
  const actualByPlatform = Object.fromEntries(
    fingerprints.map(({ platform, actual }) => [platform, actual])
  );

  if (write) {
    const next = {
      _comment:
        "Expected @expo/fingerprint hashes. Native/dependency changes must update these values after a human reviews the generated-project diff (#587 E23/F31).",
      ios: actualByPlatform.ios,
      android: actualByPlatform.android,
    };
    const platformsMoved = ["ios", "android"].filter(
      (p) => expected[p] !== next[p]
    );
    await writeFile(
      path.join(mobileRoot, "native-fingerprints.json"),
      `${JSON.stringify(next, null, 2)}\n`,
      "utf8"
    );
    const writeSummary = formatWriteSummary({
      previous: expected,
      next,
      moduleDelta,
      platformsMoved,
    });
    return {
      errors: [],
      wrote: true,
      statusText: status
        ? formatStatusReport({
            errors: [],
            moduleDelta,
            fingerprints: { expected: next, actual: actualByPlatform },
          })
        : null,
      writeSummary,
      moduleDelta,
      fingerprints: { expected: next, actual: actualByPlatform },
    };
  }

  const identityErrors = validateFingerprints(expected, actualByPlatform);
  const allErrors = attachRemediation([...recipeErrors, ...identityErrors]);
  return {
    errors: allErrors,
    wrote: false,
    statusText: status
      ? formatStatusReport({
          errors: [...recipeErrors, ...identityErrors],
          moduleDelta,
          fingerprints: { expected, actual: actualByPlatform },
        })
      : null,
    writeSummary: null,
    moduleDelta,
    fingerprints: { expected, actual: actualByPlatform },
  };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readOptionalLine(file) {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return "";
    throw error;
  }
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
  --status   human-readable L1 recipe vs L4 identity report
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
      "native-state: Pod lock, project paths, and iOS/Android fingerprints agree"
    );
  }
}
