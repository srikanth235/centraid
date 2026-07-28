import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  installedXcodeVersion,
  requiredXcodeVersion,
  versionAtLeast,
} from "./check-xcode-minimum.mjs";
import {
  podVersions,
  validateFingerprints,
  validatePodLock,
  validateReactNativePaths,
} from "./verify-native-state.mjs";

describe("native state guards", () => {
  test("rejects a stale Expo and React Native Podfile.lock", () => {
    const lock =
      "  - Expo (54.0.34):\n  - React-Core (0.81.5):\n    :tag: hermes-v0.16.0\n";
    expect(podVersions(lock)).toEqual({
      expo: "54.0.34",
      reactNative: "0.81.5",
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

  test("rejects committed iOS and Android fingerprint drift", () => {
    expect(
      validateFingerprints(
        { ios: "committed-ios", android: "committed-android" },
        { ios: "current-ios", android: "current-android" }
      )
    ).toEqual([
      "ios native fingerprint mismatch: committed committed-ios, current current-ios; review the native diff and update apps/mobile/native-fingerprints.json",
      "android native fingerprint mismatch: committed committed-android, current current-android; review the native diff and update apps/mobile/native-fingerprints.json",
    ]);
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
});
