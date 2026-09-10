import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import createExpoConfig from "../app.config";
import { nativeBuildNumber } from "./version-core.js";

const here = import.meta.dirname;
const mobileRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { nativeBuildNumber: nativeBuildNumberCjs } =
  require("./version-core.cjs") as {
    nativeBuildNumber: (version: string) => number;
  };

describe("nativeBuildNumber (J6)", () => {
  it("maps semver with the deterministic formula", () => {
    expect(nativeBuildNumber("0.1.0")).toBe(1_000);
    expect(nativeBuildNumber("1.2.3")).toBe(1_002_003);
    expect(nativeBuildNumber("0.0.1")).toBe(1);
  });

  it("CJS twin (Expo app.config path) matches the TS formula", () => {
    for (const v of ["0.1.0", "1.2.3", "0.0.1", "0.2.1-beta.3"] as const) {
      expect(nativeBuildNumberCjs(v)).toBe(nativeBuildNumber(v));
    }
  });

  it("ignores prerelease suffix in the first three numbers", () => {
    expect(nativeBuildNumber("0.2.1-beta.3")).toBe(2_001);
  });

  it("rejects garbage", () => {
    expect(() => nativeBuildNumber("nope")).toThrow(/unparseable/u);
  });

  it("matches the native build numbers the Expo config resolves for 0.1.0", () => {
    // Formula is the single source. `android/` and `ios/` are generated
    // (#996 CNG wave), so the numbers that reach a build are the ones
    // `app.config.ts` resolves — `android.versionCode`, `ios.buildNumber` and
    // `version` — not literals in a committed project. This reads the same
    // config factory `expo prebuild` calls.
    const expected = nativeBuildNumber("0.1.0");
    expect(expected).toBe(1_000);

    const config = createExpoConfig({
      config: {} as never,
    } as never);
    expect(config.version).toBe("0.1.0");
    expect(config.android?.versionCode).toBe(expected);
    expect(config.ios?.buildNumber).toBe(String(expected));
    // OTA identity rides the same semver, so an update can never be offered to
    // a binary built from a different native recipe.
    expect(config.runtimeVersion).toBe("0.1.0");

    const configSrc = readFileSync(
      path.join(mobileRoot, "app.config.ts"),
      "utf8"
    );
    expect(configSrc).toContain("nativeBuildNumber(VERSION)");
    // Version is single-sourced from package.json (#501), not hardcoded.
    expect(configSrc).toContain("readMobilePackageVersion");
    expect(configSrc).toContain("@centraid/mobile");
    const pkgVersion = JSON.parse(
      readFileSync(path.join(mobileRoot, "package.json"), "utf8")
    ).version as string;
    expect(pkgVersion).toBe("0.1.0");
    // Expo CJS resolve — must import the .cjs twin, not extensionless TS.
    expect(configSrc).toMatch(/from ['"]\.\/src\/version-core\.cjs['"]/u);
  });
});
