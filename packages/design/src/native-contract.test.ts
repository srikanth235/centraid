import { describe, expect, test } from "vitest";

import { contrastRatio } from "./color.js";
import { toNativeTheme } from "./native.js";
import {
  NATIVE_COLOR_ROLE_MAP,
  ROLE_REGISTRY,
  assertNativeColorRoleContract,
} from "./roles.js";
import { type } from "./typography.js";

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

  test("native carries the whole ramp — no profile-only type role", () => {
    // The Binding Layer's ramp is the same on all three profiles. A role only
    // one surface can render is a role that has stopped being shared, which
    // is how `hero` and `greeting` became desktop-only in the first place.
    const nativeType = toNativeTheme("light").type;
    expect(Object.keys(nativeType).sort()).toStrictEqual(
      Object.keys(type).sort()
    );
    expect("hero" in nativeType).toBe(false);
    expect("greeting" in nativeType).toBe(false);
  });

  test("the numeric register is tabular on native too", () => {
    // "Numerics are mono and tabular in every app, without exception" is only
    // true if the native lowering carries the variant; RN will not infer it.
    expect(toNativeTheme("light").type.mono.variantNumeric).toBe(
      "tabular-nums"
    );
    expect(toNativeTheme("light").type.eyebrow.textTransform).toBe("uppercase");
  });

  test("the ink fill has a hover step that moves AWAY from its ink", () => {
    for (const scheme of ["light", "dark"] as const) {
      const colors = toNativeTheme(scheme).colors;
      expect(colors.accentDeepHover, scheme).not.toBe(colors.accentFill);
      expect(
        contrastRatio(colors.textInv, colors.accentDeepHover),
        scheme
      ).toBeGreaterThanOrEqual(
        contrastRatio(colors.textInv, colors.accentFill)
      );
    }
  });

  test("the phone steps the two register roles DOWN, not up", () => {
    // Everything else gains a point or two on a phone; display and reading
    // are the two the brief gives an explicit smaller mobile size for.
    const nativeType = toNativeTheme("light").type;
    expect(nativeType.display.fontSize).toBe(27);
    expect(nativeType.reading.fontSize).toBe(17.5);
    expect(nativeType.body.fontSize).toBe(type.body.size + 2);
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
