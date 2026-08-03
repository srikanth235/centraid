import { describe, expect, test } from "vitest";

import { toNativeTheme } from "./native.js";
import {
  NATIVE_COLOR_ROLE_MAP,
  ROLE_REGISTRY,
  assertNativeColorRoleContract,
} from "./roles.js";

describe("native product-grammar lowering", () => {
  test("every emitted native color is backed by a renderable role", () => {
    const theme = toNativeTheme("light");
    expect(() => assertNativeColorRoleContract(theme.colors)).not.toThrow();

    for (const [field, css] of Object.entries(NATIVE_COLOR_ROLE_MAP)) {
      const role = ROLE_REGISTRY[css];
      if (!role) throw new Error(`Missing role ${css}`);
      expect(role.by.native.kind).not.toBe("unsupported");
      expect(field in theme.colors).toBe(true);
    }
  });

  test("light native solved values stay equal to the registry cells", () => {
    const colors = toNativeTheme("light").colors;
    for (const field of [
      "accentText",
      "accentDeepHover",
      "appIdentityText",
      "focusRingColor",
      "scrim",
      "textInv",
    ] as const) {
      const role = ROLE_REGISTRY[NATIVE_COLOR_ROLE_MAP[field]];
      if (!role) throw new Error(`Missing role for ${field}`);
      expect(role.by.native.value, field).toBe(colors[field]);
    }
  });

  test("native typography intentionally excludes web-only hero", () => {
    expect("hero" in toNativeTheme("light").type).toBe(false);
  });

  test("every native accent has a distinct hover step", () => {
    for (const accent of ["teal", "blue", "ochre", "rose", "violet"] as const) {
      for (const scheme of ["light", "dark"] as const) {
        const colors = toNativeTheme(scheme, accent).colors;
        expect(colors.accentDeepHover, `${scheme}/${accent}`).not.toBe(
          colors.accentFill
        );
      }
    }
  });

  test("rejects missing native fields and unsupported native roles", () => {
    const theme = toNativeTheme("light");
    const missingField = { ...theme.colors } as Partial<typeof theme.colors>;
    delete missingField.accent;
    expect(() => assertNativeColorRoleContract(missingField)).toThrow(
      "accent is missing from the native color emitter"
    );

    const accent = ROLE_REGISTRY["--accent"];
    if (!accent) throw new Error("missing --accent test fixture");
    const original = accent.by.native;
    try {
      accent.by.native = { kind: "unsupported", reason: "test fixture" };
      expect(() => assertNativeColorRoleContract(theme.colors)).toThrow(
        "accent is not backed by a native lowering for --accent"
      );
    } finally {
      accent.by.native = original;
    }
  });
});
