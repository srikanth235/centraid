import { readFile, writeFile } from "node:fs/promises";
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
  formatStatusReport,
  formatWriteSummary,
  generatedNativeDirsIgnored,
  moduleNativeDirsFor,
  parseNativeStateArgs,
  trackedGeneratedNativeFiles,
  validateFingerprintInputCoverage,
  validateFingerprints,
  validateGeneratedTreesNotHashed,
  validateGeneratedTreesUntracked,
  validateModulePlatformShape,
  GENERATED_NATIVE_DIRS,
} from "./verify-native-state.mjs";

const IGNORED_BOTH = {
  "apps/mobile/ios": true,
  "apps/mobile/android": true,
};

describe("native state guards", () => {
  // #996 made ios/ and android/ prebuild OUTPUTS. The one way the whole CNG
  // premise fails silently is a tracked file down there: prebuild overwrites it,
  // so the edit appears to work, ships once, and disappears.
  test("L1 fails when a prebuild output is tracked", () => {
    const errors = validateGeneratedTreesUntracked({
      trackedNativeFiles: [
        "apps/mobile/ios/Podfile.lock",
        "apps/mobile/android/app/build.gradle",
      ],
      ignoredDirs: IGNORED_BOTH,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("2 tracked file(s)");
    expect(errors[0]).toContain("apps/mobile/ios/Podfile.lock");
    expect(classifyNativeStateError(errors[0])).toBe("L1");
    const remediated = attachRemediation(errors);
    expect(remediated.at(-1)).toMatch(/fix the native inputs first/u);
    expect(remediated.at(-1)).not.toMatch(/--write`$/u);
  });

  test("L1 fails when a generated tree stops being ignored", () => {
    expect(
      validateGeneratedTreesUntracked({
        trackedNativeFiles: [],
        ignoredDirs: { "apps/mobile/ios": true, "apps/mobile/android": false },
      })
    ).toEqual([
      "L1 generated tree: apps/mobile/android is not ignored by git — the next `git add .` would commit a prebuild output (fix the native inputs first (app.config.ts, plugins/, modules/), then re-run verify; do not run --write until L1–L3 pass)",
    ]);
  });

  test("L1 passes on a clean CNG tree", () => {
    expect(
      validateGeneratedTreesUntracked({
        trackedNativeFiles: [],
        ignoredDirs: IGNORED_BOTH,
      })
    ).toEqual([]);
  });

  // The live answer, on whatever tree the suite runs against: a developer's
  // worktree (prebuilt) and CI (never prebuilt) must both say the same thing.
  test("this repository's generated trees are untracked and ignored", () => {
    expect(trackedGeneratedNativeFiles()).toEqual([]);
    expect(generatedNativeDirsIgnored()).toEqual(IGNORED_BOTH);
    expect(GENERATED_NATIVE_DIRS).toEqual([
      "apps/mobile/ios",
      "apps/mobile/android",
    ]);
  });

  // A ratchet that stops reading an input does not go red, it goes QUIET: the
  // committed hash keeps matching while the plugin it should be watching moves
  // freely. That is the #638 hole one layer up from the file it lived in.
  test("L2 fails when a config plugin is absent from the source list", () => {
    const errors = validateFingerprintInputCoverage({
      platform: "ios",
      sources: [
        { type: "file", filePath: "plugins/withCentraidIos.cjs" },
        { type: "contents", id: "expoConfig" },
        { type: "contents", id: "expoAutolinkingConfig:ios" },
      ],
      pluginFiles: [
        "plugins/withCentraidAndroidBuild.cjs",
        "plugins/withCentraidIos.cjs",
      ],
      moduleNativeDirs: [],
    });
    expect(errors).toEqual([
      "L2 input coverage: config plugin plugins/withCentraidAndroidBuild.cjs is not in the ios fingerprint source list — the ratchet cannot notice a change to it (fix the native inputs first (app.config.ts, plugins/, modules/), then re-run verify; do not run --write until L1–L3 pass)",
    ]);
    expect(classifyNativeStateError(errors[0])).toBe("L2");
  });

  test("L2 fails when autolinking has stopped seeing a local module", () => {
    const errors = validateFingerprintInputCoverage({
      platform: "android",
      sources: [
        { type: "contents", id: "expoConfig" },
        { type: "contents", id: "expoAutolinkingConfig:android" },
      ],
      pluginFiles: [],
      moduleNativeDirs: ["modules/centraid-upload/android"],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("modules/centraid-upload/android");
    expect(errors[0]).toContain("autolinking is not seeing it");
  });

  // app.config.ts never appears as a file source — Expo folds it into these two
  // synthetic ones. Losing them is the ratchet going blind to the whole config.
  test("L2 fails when the resolved config sources are missing", () => {
    const errors = validateFingerprintInputCoverage({
      platform: "ios",
      sources: [{ type: "file", filePath: "plugins/withCentraidIos.cjs" }],
      pluginFiles: ["plugins/withCentraidIos.cjs"],
      moduleNativeDirs: [],
    });
    expect(errors.map((e) => e.split(" carries")[0])).toEqual([
      "L2 input coverage: the ios fingerprint",
      "L2 input coverage: the ios fingerprint",
    ]);
    expect(errors.some((e) => e.includes("`expoConfig`"))).toBe(true);
    expect(errors.some((e) => e.includes("`expoAutolinkingConfig:ios`"))).toBe(
      true
    );
  });

  test("module native dirs are selected per platform", () => {
    const modules = [
      { moduleId: "centraid-upload", hasIosDir: false, hasAndroidDir: true },
      { moduleId: "centraid-ocr", hasIosDir: true, hasAndroidDir: true },
    ];
    expect(moduleNativeDirsFor("ios", modules)).toEqual([
      "modules/centraid-ocr/ios",
    ]);
    expect(moduleNativeDirsFor("android", modules)).toEqual([
      "modules/centraid-ocr/android",
      "modules/centraid-upload/android",
    ]);
  });

  // The host-independence layer. A prebuilt worktree has ios/ and a fresh
  // checkout does not; if either contributed content the ratchet could never
  // settle, and no edit would fix it.
  test("L3 fails when a prebuild output contributes to the hash", () => {
    const errors = validateGeneratedTreesNotHashed({
      platform: "ios",
      sources: [
        { filePath: "ios", hash: "deadbeef" },
        { filePath: "plugins/withCentraidIos.cjs", hash: "cafe" },
      ],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("hashes ios");
    expect(classifyNativeStateError(errors[0])).toBe("L3");
  });

  test("L3 accepts the emptied bareNativeDir source", () => {
    expect(
      validateGeneratedTreesNotHashed({
        platform: "android",
        sources: [
          { filePath: "android", hash: null },
          { filePath: "modules/centraid-upload/android", hash: "abc" },
        ],
      })
    ).toEqual([]);
  });

  test("L2 module shape fails when a platform directory is undeclared", () => {
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
      'L2 module shape: module centraid-ocr has an android/ directory but expo-module.config.json platforms omit "android" (fix the native inputs first (app.config.ts, plugins/, modules/), then re-run verify; do not run --write until L1–L3 pass)',
    ]);
    expect(classifyNativeStateError(errors[0])).toBe("L2");
  });

  test("L2 module shape fails when platforms list a missing config block", () => {
    expect(
      validateModulePlatformShape({
        moduleId: "centraid-storage",
        config: { platforms: ["ios", "android"], ios: { modules: ["X"] } },
        hasIosDir: true,
        hasAndroidDir: true,
      })
    ).toEqual([
      'L2 module shape: module centraid-storage lists platform "android" but has no android config block (fix the native inputs first (app.config.ts, plugins/, modules/), then re-run verify; do not run --write until L1–L3 pass)',
    ]);
  });

  test("L4 rejects committed iOS and Android fingerprint drift", () => {
    const errors = validateFingerprints(
      { ios: "committed-ios", android: "committed-android" },
      { ios: "current-ios", android: "current-android" }
    );
    expect(errors).toEqual([
      "ios native fingerprint mismatch: committed committed-ios, current current-ios; review the input diff and run `bun run --cwd apps/mobile ci:native-state --write` only after L1–L3 are green",
      "android native fingerprint mismatch: committed committed-android, current current-android; review the input diff and run `bun run --cwd apps/mobile ci:native-state --write` only after L1–L3 are green",
    ]);
    const withNext = attachRemediation(errors);
    expect(withNext.at(-1)).toContain("ci:native-state --write");
    expect(withNext.at(-1)).toContain("L4 identity only");
  });

  test("attachRemediation refuses --write messaging when an input layer is dirty", () => {
    const errors = attachRemediation([
      "L1 generated tree: 1 tracked file(s) under the prebuild outputs",
      "ios native fingerprint mismatch: committed a, current b; review",
    ]);
    expect(errors.at(-1)).toMatch(/fix the native inputs first/u);
    expect(errors.at(-1)).toContain("--write");
  });

  test("--status report distinguishes the input layers from L4 identity", () => {
    const text = formatStatusReport({
      errors: [
        "L1 generated tree: 1 tracked file(s) under the prebuild outputs",
        "ios native fingerprint mismatch: committed a, current b; review",
      ],
      inputInventory: {
        pluginFiles: ["plugins/withCentraidIos.cjs"],
        modules: ["centraid-ocr"],
      },
      fingerprints: {
        expected: { ios: "a", android: "c" },
        actual: { ios: "b", android: "c" },
      },
    });
    expect(text).toContain("L1: FAIL");
    expect(text).toContain("L2: ok");
    expect(text).toContain("L3: ok");
    expect(text).toContain("L4: FAIL");
    expect(text).toContain("generated-tree purity");
    expect(text).toContain("identity ratchet");
    expect(text).toContain("plugins [plugins/withCentraidIos.cjs]");
  });

  test("--write curated summary names platforms moved and the inputs validated", () => {
    const summary = formatWriteSummary({
      previous: { ios: "old-ios", android: "old-android" },
      next: { ios: "new-ios", android: "old-android" },
      inputInventory: {
        pluginFiles: ["plugins/withCentraidIos.cjs"],
        modules: ["centraid-storage", "centraid-tunnel"],
      },
      platformsMoved: ["ios"],
    });
    expect(summary).toContain("platforms moved: ios");
    expect(summary).toContain("old-ios → new-ios");
    expect(summary).toContain("centraid-storage");
  });

  test("parseNativeStateArgs accepts --status and --write", () => {
    expect(parseNativeStateArgs(["--status", "--write"])).toEqual({
      write: true,
      status: true,
    });
    expect(() => parseNativeStateArgs(["--bogus"])).toThrow(/unknown flag/u);
  });

  test("fingerprint options ignore the prebuild outputs and deafen scripts", () => {
    expect(NATIVE_FINGERPRINT_SOURCE_SKIPS).toBe(
      SourceSkips.PackageJsonScriptsAll
    );
    expect(NATIVE_FINGERPRINT_IGNORE_PATHS).toContain("ios/**");
    expect(NATIVE_FINGERPRINT_IGNORE_PATHS).toContain("android/**");
    const opts = nativeFingerprintOptions("ios");
    expect(opts.sourceSkips).toBe(SourceSkips.PackageJsonScriptsAll);
    expect(opts.ignorePaths).toEqual(NATIVE_FINGERPRINT_IGNORE_PATHS);
  });

  test("shipped fingerprint options omit packageJson:scripts and never hash a prebuild output", async () => {
    // Drives createFingerprintAsync with the real options object from
    // native-fingerprint.mjs — proves both properties are wired, not declared.
    // The L3 half is asserted on the real source list rather than on the ignore
    // array, so it holds whether or not this machine has prebuilt.
    const { createFingerprintAsync } = await import("@expo/fingerprint");
    const mobileRoot = path.resolve(import.meta.dirname, "..");
    const fingerprints = await Promise.all(
      ["ios", "android"].map(async (platform) => ({
        platform,
        fp: await createFingerprintAsync(
          mobileRoot,
          nativeFingerprintOptions(platform)
        ),
      }))
    );
    for (const { platform, fp } of fingerprints) {
      expect(fp.hash).toMatch(/^[a-f0-9]{40}$/u);
      const scriptSources = fp.sources.filter(
        (s) =>
          s.id === "packageJson:scripts" ||
          (Array.isArray(s.reasons) &&
            s.reasons.includes("packageJson:scripts"))
      );
      expect(scriptSources).toEqual([]);
      expect(
        validateGeneratedTreesNotHashed({ platform, sources: fp.sources })
      ).toEqual([]);
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
