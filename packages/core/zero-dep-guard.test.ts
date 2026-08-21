import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { assertZeroRuntimeDeps } from "./zero-dep-guard.js";

const MANIFEST_PATH = path.resolve(import.meta.dirname, "package.json");

describe("zero-runtime-dep guard", () => {
  test("the shipped @centraid/core package.json has no runtime deps", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
      name: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.name).toBe("@centraid/core");
    expect(assertZeroRuntimeDeps(manifest)).toStrictEqual({ ok: true });
  });

  test("fails when a runtime dependency is introduced", () => {
    const verdict = assertZeroRuntimeDeps({
      name: "@centraid/core",
      dependencies: { leftover: "1.0.0" },
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected failure");
    expect(verdict.reason).toMatch(/leftover/u);
  });

  test("fails on optional or peer runtime deps as well", () => {
    expect(
      assertZeroRuntimeDeps({
        name: "@centraid/core",
        optionalDependencies: { sharp: "0.33.0" },
      }).ok
    ).toBe(false);
    expect(
      assertZeroRuntimeDeps({
        name: "@centraid/core",
        peerDependencies: { react: "19" },
      }).ok
    ).toBe(false);
  });
});
