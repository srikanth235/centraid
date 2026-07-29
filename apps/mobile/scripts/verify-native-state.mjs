#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fingerprintForPlatform } from "./native-fingerprint.mjs";

const mobileRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(mobileRoot, "..", "..");
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
        `${platform} native fingerprint mismatch: committed ${expected[platform] ?? "missing"}, current ${actual}; review the native diff and update apps/mobile/native-fingerprints.json`
      );
    }
  }
  return errors;
}

export async function verifyNativeState() {
  const [
    expected,
    lock,
    project,
    expoPackage,
    reactNativePackage,
    hermesTag,
    hermesV1Tag,
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
  ]);
  const errors = [
    ...validatePodLock({
      lock,
      expoVersion: expoPackage.version,
      reactNativeVersion: reactNativePackage.version,
      hermesTags: [hermesTag, hermesV1Tag].filter(Boolean),
    }),
    ...validateReactNativePaths(project, {
      podsRoot: path.join(mobileRoot, "ios", "Pods"),
      expected: path.join(repoRoot, "node_modules", "react-native"),
    }),
  ];
  const fingerprints = await Promise.all(
    ["ios", "android"].map(async (platform) => ({
      platform,
      actual: await fingerprintForPlatform(platform),
    }))
  );
  errors.push(
    ...validateFingerprints(
      expected,
      Object.fromEntries(
        fingerprints.map(({ platform, actual }) => [platform, actual])
      )
    )
  );
  return errors;
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
  const errors = await verifyNativeState();
  if (errors.length) {
    for (const error of errors) console.error(`native-state: ${error}`);
    process.exit(1);
  }
  console.log(
    "native-state: Pod lock, project paths, and iOS/Android fingerprints agree"
  );
}
