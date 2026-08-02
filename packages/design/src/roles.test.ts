import { describe, expect, test } from "vitest";

import { BLUEPRINT_TOKEN_CONTRACT, SHELL_TOKEN_CONTRACT } from "./contract.js";
import {
  ADAPTERS,
  PROFILE_SURFACES,
  ROLE_REGISTRY,
  assertTotalProfileValues,
  contractForProfile,
  profileForSurface,
  rolesForProfile,
} from "./roles.js";

describe("product-grammar role registry", () => {
  test("every registered role has an explicit lowering for every profile", () => {
    expect(() => assertTotalProfileValues()).not.toThrow();
    for (const role of Object.values(ROLE_REGISTRY)) {
      expect(role.css).toMatch(/^--/u);
      expect(role.meaning.length).toBeGreaterThan(10);
      expect(role.contrast.length).toBeGreaterThan(5);
    }
  });

  test("profile contracts cover every emitted semantic role", () => {
    const emitted = new Set([
      ...SHELL_TOKEN_CONTRACT,
      ...BLUEPRINT_TOKEN_CONTRACT,
    ]);
    for (const role of Object.values(ROLE_REGISTRY)) {
      expect(
        emitted.has(role.css),
        `${role.css} is not emitted by a CSS profile`
      ).toBe(true);
    }
    for (const adapter of Object.values(ADAPTERS)) {
      expect(adapter.css).toMatch(/^--/u);
    }
  });

  test("surface mapping is total and profile contracts are non-empty", () => {
    for (const surface of ["SH", "SH-c", "BI", "BS", "MO"] as const) {
      const profile = profileForSurface(surface);
      expect(PROFILE_SURFACES[profile]).toContain(surface);
      expect(contractForProfile(profile).length).toBeGreaterThan(0);
      expect(
        rolesForProfile(profile).every((role) => role.surfaces.length > 0)
      ).toBe(true);
    }
  });

  test("rejects missing and unexplained profile lowerings", () => {
    const accent = ROLE_REGISTRY["--accent"];
    if (!accent) throw new Error("missing --accent test fixture");
    const originalNative = accent.by.native;
    try {
      delete (accent.by as Partial<typeof accent.by>).native;
      expect(() => assertTotalProfileValues()).toThrow(
        "--accent has no native lowering"
      );
    } finally {
      accent.by.native = originalNative;
    }

    const appBackground = ROLE_REGISTRY["--bg-app"];
    if (!appBackground) throw new Error("missing --bg-app test fixture");
    const originalReason = appBackground.by.native.reason;
    try {
      appBackground.by.native.reason = undefined;
      expect(() => assertTotalProfileValues()).toThrow(
        "--bg-app unsupported native lowering has no reason"
      );
    } finally {
      appBackground.by.native.reason = originalReason;
    }
  });
});
