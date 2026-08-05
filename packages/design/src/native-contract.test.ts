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
      "stageSunken",
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

  test("the native rule is a FULL point, not the platform hairline", () => {
    // The v4 handoff draws every border and rule as `border: 1px solid`, and
    // the native lowering has to carry that number itself: React Native's
    // `StyleSheet.hairlineWidth` is one PHYSICAL pixel, so on a 3× phone it is
    // 0.33pt — a third of the specified edge, on surfaces whose fill is only a
    // few percent off the page. `scripts/lint-hairline.mjs` keeps call sites
    // off the platform value; this keeps the token they reach for at 1.
    for (const scheme of ["light", "dark"] as const) {
      expect(toNativeTheme(scheme).borders.hairline, scheme).toBe(1);
    }
  });

  test("the page margin is lowered, and is NOT a spacing rung", () => {
    // `R.margin:{d:32,m:18}` (handoff line 3356) is a scale of its own,
    // parallel to `R.gap`. Before this token existed, 18 was unrepresentable:
    // Home hard-coded it and Photos substituted 16 and 10, so two screens of
    // one product started their pages in different places.
    for (const scheme of ["light", "dark"] as const) {
      expect(toNativeTheme(scheme).pageMargin, scheme).toBe(18);
    }
    // The point of a separate scale — if 18 were ever quietly snapped onto the
    // 4px gap ladder this assertion is what notices.
    expect(Object.values(toNativeTheme("light").spacing)).not.toContain(18);
  });

  test("the scrim is the handoff's veil, not a heavier cold plate", () => {
    // Handoff line 5101: `dark?'rgba(0,0,0,.62)':'rgba(26,24,21,.3)'`. Ours
    // was rgba(20,20,20,0.48) / rgba(0,0,0,0.72) — 60% over the specified
    // alpha on light, and on the cool ink rather than the warm one the
    // ink-on-paper flip settled on.
    expect(toNativeTheme("light").colors.scrim).toBe("rgba(26,24,21,0.3)");
    expect(toNativeTheme("dark").colors.scrim).toBe("rgba(0,0,0,0.62)");
  });

  test("the stage carries its own sunken rung, one literal in both themes", () => {
    // Handoff line 4479: the stage-local palette's `sunken:'#1A1A19'`, used by
    // the media transport's empty track (line 4552). `--stage-line` (#2A2A29)
    // was the stand-in and reads too light: a hairline is tuned to be SEEN,
    // a trough to recede under its fill.
    for (const scheme of ["light", "dark"] as const) {
      expect(toNativeTheme(scheme).colors.stageSunken, scheme).toBe("#1A1A19");
    }
    expect(toNativeTheme("light").colors.stageSunken).not.toBe(
      toNativeTheme("light").colors.stageLine
    );
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
