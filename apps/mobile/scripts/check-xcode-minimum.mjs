#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const helpersPath = path.join(
  repoRoot,
  "node_modules",
  "react-native",
  "scripts",
  "cocoapods",
  "helpers.rb"
);
const expoModulesJsiPackagePath = path.join(
  repoRoot,
  "node_modules",
  "expo-modules-jsi",
  "apple",
  "Package.swift"
);

/**
 * Expo SDK 56+/57 ship expo-modules-jsi with `swift-tools-version: 6.2` and
 * document Xcode 26.4+ (Swift 6.3). Older hosts fail the JSI xcframework
 * build with a misleading empty "Could not resolve package dependencies"
 * footer (see #620 / run 30417451436 on Xcode 16.4).
 */
export const EXPO_MODULES_JSI_MIN_XCODE = "26.4";

export function requiredXcodeVersion(helpers) {
  const match =
    /def self\.min_xcode_version_supported[\s\S]{0,160}?return ['"](?<version>\d+(?:\.\d+)*)['"]/u.exec(
      helpers
    );
  if (!match?.groups?.version) {
    throw new Error("React Native minimum Xcode version could not be parsed");
  }
  return match.groups.version;
}

export function expoModulesJsiSwiftToolsVersion(packageSwift) {
  const match =
    /^\/\/\s*swift-tools-version:\s*(?<version>\d+(?:\.\d+)*)/mu.exec(
      packageSwift
    );
  if (!match?.groups?.version) {
    throw new Error(
      "expo-modules-jsi swift-tools-version could not be parsed from Package.swift"
    );
  }
  return match.groups.version;
}

/**
 * When expo-modules-jsi declares Swift tools ≥ 6.2, require Expo's documented
 * Xcode floor. Absent / older Package.swift falls back to React Native alone.
 */
export function expoModulesJsiMinXcode(packageSwift) {
  const tools = expoModulesJsiSwiftToolsVersion(packageSwift);
  if (versionAtLeast(tools, "6.2")) return EXPO_MODULES_JSI_MIN_XCODE;
  return null;
}

export function installedXcodeVersion(output) {
  const match = /^Xcode\s+(?<version>\d+(?:\.\d+)*)/mu.exec(output);
  if (!match?.groups?.version) {
    throw new Error(`installed Xcode version could not be parsed: ${output}`);
  }
  return match.groups.version;
}

export function versionAtLeast(actual, required) {
  const left = actual.split(".").map(Number);
  const right = required.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

export function maxVersion(...versions) {
  return versions.reduce((best, next) =>
    versionAtLeast(next, best) ? next : best
  );
}

async function recordInfraMismatch(message) {
  const directory = path.join(repoRoot, "artifacts", "e2e");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "mobile-xcode-infra.json"),
    `${JSON.stringify(
      {
        lane: "e2e",
        owner: "tests/agent-e2e-mobile/flows/home-loads.mjs",
        name: "mobile Xcode compatibility",
        status: "infra-mismatch",
        capturedAt: new Date().toISOString(),
        error: message,
        measurements: [],
      },
      null,
      2
    )}\n`
  );
}

export async function checkXcodeMinimum(options = {}) {
  const helpers = options.helpers ?? (await readFile(helpersPath, "utf8"));
  const packageSwift =
    options.packageSwift ?? (await readFile(expoModulesJsiPackagePath, "utf8"));
  const xcodeOutput =
    options.xcodeOutput ??
    execFileSync("xcodebuild", ["-version"], {
      encoding: "utf8",
    });
  const reactNativeRequired = requiredXcodeVersion(helpers);
  const expoRequired = expoModulesJsiMinXcode(packageSwift);
  const required = expoRequired
    ? maxVersion(reactNativeRequired, expoRequired)
    : reactNativeRequired;
  const actual = installedXcodeVersion(xcodeOutput);
  if (!versionAtLeast(actual, required)) {
    const parts = [`React Native ${reactNativeRequired}`];
    if (expoRequired) {
      parts.push(
        `expo-modules-jsi Swift tools ${expoModulesJsiSwiftToolsVersion(packageSwift)} → Xcode ${expoRequired}`
      );
    }
    const message = `runner Xcode ${actual} is older than required ${required} (${parts.join("; ")})`;
    await recordInfraMismatch(message);
    throw new Error(message);
  }
  return {
    actual,
    required,
    reactNativeRequired,
    expoRequired,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const result = await checkXcodeMinimum();
    const extras = [];
    if (result.expoRequired) {
      extras.push(`expo-modules-jsi floor ${result.expoRequired}`);
    }
    console.log(
      `xcode-compat: installed ${result.actual}, required ${result.required}` +
        (extras.length ? ` (${extras.join(", ")})` : "")
    );
  } catch (error) {
    console.error(
      `::error title=Mobile runner infrastructure::${error.message}`
    );
    process.exit(1);
  }
}
