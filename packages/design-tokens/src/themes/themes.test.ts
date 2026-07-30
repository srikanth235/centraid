/**
 * Theme registry invariants (#608 group O).
 *
 * The registry used to carry twelve presets while every shell stylesheet
 * keyed literally on `[data-theme='dark']`. Picking Nord or Monokai took the
 * dark tokens and left the toast + connection brand-mark rules unfired —
 * light chrome painted over a dark surface, with nothing in the UI to
 * explain it. The cut to two presets makes the literal selector correct
 * again; these tests keep it correct.
 */
import { describe, expect, test } from "vitest";

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
    // Load-bearing: `toast.module.css` and `SettingsConnectionsScreen
    // .module.css` select on the theme NAME but mean the theme KIND. While
    // the two coincide, no dark preset can slip past those rules.
    for (const [name, theme] of Object.entries(themes)) {
      expect(theme.kind, `theme '${name}' declares kind '${theme.kind}'`).toBe(
        name
      );
    }
    for (const preset of THEME_PRESETS) {
      expect(preset.kind).toBe(themes[preset.name].kind);
    }
  });

  test("only the dark ramp carries a --bg-l anchor", () => {
    expect(themes.dark.bgL).toBeDefined();
    expect(themes.light.bgL).toBeUndefined();
  });
});
