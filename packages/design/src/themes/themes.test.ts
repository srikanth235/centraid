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
    const lum = (value: string): number =>
      relativeLuminance(parseColor(value).rgb);
    expect(lum(themes.light.bgElev)).toBeLessThan(lum(themes.light.bg));
    expect(lum(themes.dark.bgElev)).toBeGreaterThan(lum(themes.dark.bg));
  });

  test("neither theme spends a hue on the shell", () => {
    for (const theme of Object.values(themes)) {
      expect(theme.accent).toBe(theme.text);
      expect(theme.accentText).toBe(theme.text);
      expect(theme.accentDeep).toBe(theme.text);
    }
  });
});
