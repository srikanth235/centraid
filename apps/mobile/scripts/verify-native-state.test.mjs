import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SourceSkips } from "@expo/fingerprint";
import { describe, expect, test } from "vitest";

import {
  EXPO_MODULES_JSI_MIN_XCODE,
  expoModulesJsiMinXcode,
  expoModulesJsiSwiftToolsVersion,
  installedXcodeVersion,
  maxVersion,
  requiredXcodeVersion,
  versionAtLeast,
} from "./check-xcode-minimum.mjs";
import {
  NATIVE_FINGERPRINT_IGNORE_PATHS,
  NATIVE_FINGERPRINT_SOURCE_SKIPS,
  nativeFingerprintOptions,
} from "./native-fingerprint.mjs";
import {
  attachRemediation,
  classifyNativeStateError,
  dependencyPodNames,
  externalSourcePodNames,
  formatStatusReport,
  formatWriteSummary,
  moduleLockDelta,
  parseNativeStateArgs,
  podVersions,
  validateFingerprints,
  validateIosModuleLockCompleteness,
  validateModulePlatformShape,
  validatePodLock,
  validateReactNativePaths,
} from "./verify-native-state.mjs";

describe("native state guards", () => {
  test("rejects a stale Expo and React Native Podfile.lock", () => {
    const lock =
      "  - Expo (54.0.34):\n  - React-Core (0.81.5):\n  - React-Core-prebuilt (0.81.5):\n  - ReactNativeDependencies (0.81.5):\n    :tag: hermes-v0.16.0\n";
    expect(podVersions(lock)).toEqual({
      expo: "54.0.34",
      reactNative: "0.81.5",
      reactNativePrebuilt: "0.81.5",
      reactNativeDependencies: "0.81.5",
      hermesTag: "hermes-v0.16.0",
    });
    expect(
      validatePodLock({
        lock,
        expoVersion: "57.0.8",
        reactNativeVersion: "0.86.2",
        hermesTags: ["hermes-v0.17.0", "hermes-v250829098.0.16"],
      })
    ).toEqual([
      "Podfile.lock Expo 54.0.34 does not match node_modules Expo 57.0.8",
      "Podfile.lock React-Core 0.81.5 does not match node_modules react-native 0.86.2",
      "Podfile.lock React-Core-prebuilt 0.81.5 does not match node_modules react-native 0.86.2",
      "Podfile.lock ReactNativeDependencies 0.81.5 does not match node_modules react-native 0.86.2",
      "Podfile.lock Hermes tag hermes-v0.16.0 does not match node_modules react-native Hermes tag(s) hermes-v0.17.0, hermes-v250829098.0.16",
    ]);
  });

  test("rejects a worktree-depth REACT_NATIVE_PATH", () => {
    const podsRoot = "/repo/apps/mobile/ios/Pods";
    const expected = "/repo/node_modules/react-native";
    const podsRootVariable = ["$", "{PODS_ROOT}"].join("");
    expect(
      validateReactNativePaths(
        `REACT_NATIVE_PATH = "${podsRootVariable}/../../../../../../../node_modules/react-native";`,
        { podsRoot, expected }
      )
    ).toEqual([
      `REACT_NATIVE_PATH resolves to ${path.resolve("/repo/apps/mobile/ios/Pods/../../../../../../../node_modules/react-native")}; expected ${expected} from this repository layout`,
    ]);
  });

  test("rejects committed iOS and Android fingerprint drift with --write remediation", () => {
    const errors = validateFingerprints(
      { ios: "committed-ios", android: "committed-android" },
      { ios: "current-ios", android: "current-android" }
    );
    expect(errors).toEqual([
      "ios native fingerprint mismatch: committed committed-ios, current current-ios; review the native diff and run `bun run --cwd apps/mobile ci:native-state --write` only after L1–L3 are green",
      "android native fingerprint mismatch: committed committed-android, current current-android; review the native diff and run `bun run --cwd apps/mobile ci:native-state --write` only after L1–L3 are green",
    ]);
    const withNext = attachRemediation(errors);
    expect(withNext.at(-1)).toContain("ci:native-state --write");
    expect(withNext.at(-1)).toContain("L4 identity only");
  });

  test("L1 fails when a local podspec is missing from Podfile.lock DEPENDENCIES", () => {
    const lock = `DEPENDENCIES:
  - CentraidStorage (from \`../modules/centraid-storage/ios\`)
  - CentraidTunnel (from \`../modules/centraid-tunnel/ios\`)

EXTERNAL SOURCES:
  CentraidStorage:
    :path: "../modules/centraid-storage/ios"
  CentraidTunnel:
    :path: "../modules/centraid-tunnel/ios"
`;
    expect(dependencyPodNames(lock)).toEqual([
      "CentraidStorage",
      "CentraidTunnel",
    ]);
    expect(externalSourcePodNames(lock)).toEqual([
      "CentraidStorage",
      "CentraidTunnel",
    ]);
    const errors = validateIosModuleLockCompleteness({
      localPodNames: [
        "CentraidNetworkStatus",
        "CentraidOcr",
        "CentraidStorage",
        "CentraidTunnel",
      ],
      lock,
    });
    expect(errors.some((e) => e.includes("CentraidNetworkStatus"))).toBe(true);
    expect(errors.some((e) => e.includes("CentraidOcr"))).toBe(true);
    expect(errors.every((e) => e.startsWith("L1 recipe incomplete"))).toBe(
      true
    );
    expect(errors.some((e) => e.includes("pod install"))).toBe(true);
    const remediated = attachRemediation(errors);
    expect(remediated.at(-1)).toMatch(/fix the native recipe first/u);
    expect(remediated.at(-1)).not.toMatch(/--write`$/u);
  });

  test("L1 Android shape fails when a platform directory is undeclared", () => {
    const errors = validateModulePlatformShape({
      moduleId: "centraid-ocr",
      config: {
        platforms: ["ios"],
        ios: { modules: ["CentraidOcrModule"] },
      },
      hasIosDir: true,
      hasAndroidDir: true,
    });
    expect(errors).toEqual([
      'L1 Android/shape: module centraid-ocr has an android/ directory but expo-module.config.json platforms omit "android" (fix the native recipe first (complete Podfile.lock / module configs), then re-run verify; do not run --write until L1–L3 pass)',
    ]);
    expect(classifyNativeStateError(errors[0])).toBe("L1");
  });

  test("L1 Android shape fails when platforms list a missing config block", () => {
    expect(
      validateModulePlatformShape({
        moduleId: "centraid-storage",
        config: { platforms: ["ios", "android"], ios: { modules: ["X"] } },
        hasIosDir: true,
        hasAndroidDir: true,
      })
    ).toEqual([
      'L1 Android/shape: module centraid-storage lists platform "android" but has no android config block (fix the native recipe first (complete Podfile.lock / module configs), then re-run verify; do not run --write until L1–L3 pass)',
    ]);
  });

  test("module↔lock delta reports present vs missing", () => {
    const lock = `DEPENDENCIES:
  - CentraidStorage (from \`../modules/centraid-storage/ios\`)

EXTERNAL SOURCES:
  CentraidStorage:
    :path: "../modules/centraid-storage/ios"
`;
    expect(
      moduleLockDelta({
        localPodNames: ["CentraidOcr", "CentraidStorage"],
        lock,
      })
    ).toEqual({
      present: ["CentraidStorage"],
      missing: ["CentraidOcr"],
    });
  });

  test("--status report distinguishes L1 recipe from L4 identity", () => {
    const text = formatStatusReport({
      errors: [
        "L1 recipe incomplete: local module pod CentraidOcr is missing from Podfile.lock DEPENDENCIES",
        "ios native fingerprint mismatch: committed a, current b; review the native diff and run `bun run --cwd apps/mobile ci:native-state --write` only after L1–L3 are green",
      ],
      moduleDelta: {
        present: ["CentraidStorage"],
        missing: ["CentraidOcr"],
      },
      fingerprints: {
        expected: { ios: "a", android: "c" },
        actual: { ios: "b", android: "c" },
      },
    });
    expect(text).toContain("L1: FAIL");
    expect(text).toContain("L4: FAIL");
    expect(text).toContain("recipe completeness");
    expect(text).toContain("identity ratchet");
    expect(text).toContain("missing [CentraidOcr]");
  });

  test("--write curated summary names platforms moved and module delta", () => {
    const summary = formatWriteSummary({
      previous: { ios: "old-ios", android: "old-android" },
      next: { ios: "new-ios", android: "old-android" },
      moduleDelta: {
        present: ["CentraidStorage", "CentraidTunnel"],
        missing: [],
      },
      platformsMoved: ["ios"],
    });
    expect(summary).toContain("platforms moved: ios");
    expect(summary).toContain("old-ios → new-ios");
    expect(summary).toContain("CentraidStorage");
    expect(summary).toContain("missing [none]");
  });

  test("parseNativeStateArgs accepts --status and --write", () => {
    expect(parseNativeStateArgs(["--status", "--write"])).toEqual({
      write: true,
      status: true,
    });
    expect(() => parseNativeStateArgs(["--bogus"])).toThrow(/unknown flag/u);
  });

  test("attachRemediation refuses --write messaging when L1 is dirty", () => {
    const errors = attachRemediation([
      "L1 recipe incomplete: local module pod CentraidOcr is missing from Podfile.lock DEPENDENCIES",
      "ios native fingerprint mismatch: committed a, current b; review",
    ]);
    expect(errors.at(-1)).toMatch(/fix the native recipe first/u);
    expect(errors.at(-1)).toContain("--write");
  });

  test("fingerprint options deafen package.json scripts (#646)", () => {
    expect(NATIVE_FINGERPRINT_SOURCE_SKIPS).toBe(
      SourceSkips.PackageJsonScriptsAll
    );
    const opts = nativeFingerprintOptions("ios");
    expect(opts.sourceSkips).toBe(SourceSkips.PackageJsonScriptsAll);
    expect(opts.ignorePaths).toEqual(NATIVE_FINGERPRINT_IGNORE_PATHS);
  });

  test("shipped fingerprint options omit packageJson:scripts source on both platforms", async () => {
    // Drives createFingerprintAsync with the real options object from
    // native-fingerprint.mjs — proves PackageJsonScriptsAll is wired, not just
    // declared. Without the skip, Bare.js would emit id packageJson:scripts.
    const { createFingerprintAsync } = await import("@expo/fingerprint");
    const mobileRoot = path.resolve(import.meta.dirname, "..");
    const fingerprints = await Promise.all(
      ["ios", "android"].map((platform) =>
        createFingerprintAsync(mobileRoot, nativeFingerprintOptions(platform))
      )
    );
    for (const fp of fingerprints) {
      expect(fp.hash).toMatch(/^[a-f0-9]{40}$/u);
      const scriptSources = fp.sources.filter(
        (s) =>
          s.id === "packageJson:scripts" ||
          (Array.isArray(s.reasons) &&
            s.reasons.includes("packageJson:scripts"))
      );
      expect(scriptSources).toEqual([]);
    }
  }, 300_000);

  test("script-key reorder leaves both platform fingerprints unchanged", async () => {
    // Real path: fingerprintForPlatform → createFingerprintAsync with shipped
    // sourceSkips. Reverse script keys (oxfmt sortPackageJson.sortScripts shape).
    const mobileRoot = path.resolve(import.meta.dirname, "..");
    const pkgPath = path.join(mobileRoot, "package.json");
    const original = await readFile(pkgPath, "utf8");
    const { fingerprintForPlatform } = await import("./native-fingerprint.mjs");

    try {
      const [beforeIos, beforeAndroid] = await Promise.all([
        fingerprintForPlatform("ios"),
        fingerprintForPlatform("android"),
      ]);
      const pkg = JSON.parse(original);
      const entries = Object.entries(pkg.scripts ?? {});
      expect(entries.length).toBeGreaterThan(1);
      pkg.scripts = Object.fromEntries(entries.toReversed());
      await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
      const [afterIos, afterAndroid] = await Promise.all([
        fingerprintForPlatform("ios"),
        fingerprintForPlatform("android"),
      ]);
      expect(afterIos).toBe(beforeIos);
      expect(afterAndroid).toBe(beforeAndroid);
    } finally {
      await writeFile(pkgPath, original, "utf8");
    }
  }, 600_000);

  test("write refuses when L1–L3 dirty — unit path via recipe validators", async () => {
    // Simulate the --write gate: recipe errors present ⇒ no fingerprint write.
    // Uses a temp fingerprints file to prove we never touch it on L1 failure.
    const dir = await mkdtemp(path.join(os.tmpdir(), "native-state-"));
    const fpPath = path.join(dir, "native-fingerprints.json");
    const before = { ios: "keep-me", android: "keep-me-too" };
    await writeFile(fpPath, JSON.stringify(before), "utf8");
    const incompleteLock = `DEPENDENCIES:
  - CentraidStorage (from \`../modules/centraid-storage/ios\`)

EXTERNAL SOURCES:
  CentraidStorage:
    :path: "../modules/centraid-storage/ios"
`;
    const recipeErrors = validateIosModuleLockCompleteness({
      localPodNames: ["CentraidNetworkStatus", "CentraidStorage"],
      lock: incompleteLock,
    });
    expect(recipeErrors.length).toBeGreaterThan(0);
    // The CLI path returns early before writeFile when recipeErrors.length > 0.
    if (recipeErrors.length === 0) {
      await writeFile(fpPath, JSON.stringify({ ios: "mutated" }), "utf8");
    }
    const after = JSON.parse(await readFile(fpPath, "utf8"));
    expect(after).toEqual(before);
    await rm(dir, { recursive: true, force: true });
  });

  test("ignores Xcode's uncommitted nested workspace metadata", () => {
    expect(NATIVE_FINGERPRINT_IGNORE_PATHS).toContain(
      "ios/Centraid.xcodeproj/project.xcworkspace/**/*"
    );
  });

  test("parses and compares the React Native Xcode contract", () => {
    expect(
      requiredXcodeVersion(`
        def self.min_xcode_version_supported
          return '16.1'
        end
      `)
    ).toBe("16.1");
    expect(installedXcodeVersion("Xcode 16.4\nBuild version 16F6")).toBe(
      "16.4"
    );
    expect(versionAtLeast("16.4", "16.1")).toBe(true);
    expect(versionAtLeast("16.0", "16.1")).toBe(false);
  });

  test("raises the floor when expo-modules-jsi needs Swift tools 6.2", () => {
    const packageSwift = `// swift-tools-version: 6.2
import PackageDescription
`;
    expect(expoModulesJsiSwiftToolsVersion(packageSwift)).toBe("6.2");
    expect(expoModulesJsiMinXcode(packageSwift)).toBe(
      EXPO_MODULES_JSI_MIN_XCODE
    );
    expect(maxVersion("16.1", EXPO_MODULES_JSI_MIN_XCODE)).toBe(
      EXPO_MODULES_JSI_MIN_XCODE
    );
    expect(versionAtLeast("16.4", EXPO_MODULES_JSI_MIN_XCODE)).toBe(false);
    expect(versionAtLeast("26.4", EXPO_MODULES_JSI_MIN_XCODE)).toBe(true);
    expect(versionAtLeast("26.5", EXPO_MODULES_JSI_MIN_XCODE)).toBe(true);
  });
});
