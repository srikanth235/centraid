/**
 * Theme registry invariants (#608 group O).
 *
 * The registry carries exactly two presets, and every shell stylesheet keys
 * literally on `[data-theme='dark']`. A further preset would take the dark
 * tokens and leave the connection brand-mark rules unfired — light chrome
 * painted over a dark surface, with nothing in the UI to explain it. Two
 * presets are what makes the literal selector correct; these tests keep it
 * correct.
 */
import { describe, expect, test } from "vitest";

import { parseColor, relativeLuminance } from "../color.js";
import { THEME_PRESETS, themes } from "./index.js";

describe("theme registry", () => {
  test("offers exactly Centraid Light and Centraid Dark", () => {
    expect(Object.keys(themes)).toStrictEqual(["light", "dark"]);
    expect(THEME_PRESETS.map((p) => p.name)).toStrictEqual(["light", "dark"]);
  });

  test("every preset in the display list is a registered theme", () => {
    for (const preset of THEME_PRESETS) {
      expect(themes[preset.name]).toBeDefined();
      expect(preset.label).not.toBe("");
    }
    expect(THEME_PRESETS).toHaveLength(Object.keys(themes).length);
  });

  test("a registry key equals its kind, so `[data-theme='dark']` is exact", () => {
    // Load-bearing: `SettingsConnectionsScreen.module.css` and
    // `RecoverScreen.module.css` select on the theme NAME but mean the theme
    // KIND. While the two coincide, no dark preset can slip past those rules.
    for (const [name, theme] of Object.entries(themes)) {
      expect(theme.kind, `theme '${name}' declares kind '${theme.kind}'`).toBe(
        name
      );
    }
    for (const preset of THEME_PRESETS) {
      expect(preset.kind).toBe(themes[preset.name].kind);
    }
  });

  test("both ramps are literal — there is no derived surface anchor", () => {
    // No surface derives from a `--bg-l` lightness through
    // `hsl(0 0% calc(...))`: the dark paper is warm-tinted (`#171716`, not
    // `hsl(0 0% 9%)`), which a one-knob greyscale calc cannot express and
    // which is not faked with a saturation parameter. Every surface is a
    // value you can read.
    for (const theme of Object.values(themes)) {
      for (const surface of [
        theme.bg,
        theme.bgElev,
        theme.bgSunken,
        theme.bgApp,
      ]) {
        expect(surface).toMatch(/^#[0-9A-Fa-f]{6}$/u);
      }
    }
  });

  test("the raised surface is paper, not elevation", () => {
    // Light: the raised surface is DARKER than the page. Dark: LIGHTER. A
    // tile is a sheet laid on the page, which is why `--text-faint` is
    // validated against `--bg-elev` in dark and the deepest tone in light.
    const lum = (value: string): number =>
      relativeLuminance(parseColor(value).rgb);
    expect(lum(themes.light.bgElev)).toBeLessThan(lum(themes.light.bg));
    expect(lum(themes.dark.bgElev)).toBeGreaterThan(lum(themes.dark.bg));
  });

  test("neither theme spends a hue on the shell", () => {
    // `--accent` is ink in both ramps. If this ever stops being true, every
    // app identity hue silently stops meaning "this belongs to that app".
    for (const theme of Object.values(themes)) {
      expect(theme.accent).toBe(theme.text);
      expect(theme.accentText).toBe(theme.text);
      expect(theme.accentDeep).toBe(theme.text);
    }
  });
});
