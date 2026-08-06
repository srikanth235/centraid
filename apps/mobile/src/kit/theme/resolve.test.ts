import { describe, expect, it } from "vitest";

import { navThemeFor, navThemes, resolveTheme } from "./resolve";
import { darkPalette, lightPalette } from "./tokens.generated";

describe("theme resolution", () => {
  it("selects concrete palette by scheme", () => {
    expect(resolveTheme("light").colors).toBe(lightPalette);
    expect(resolveTheme("dark").colors).toBe(darkPalette);
    expect(resolveTheme("dark").colors.bg).not.toBe(lightPalette.bg);
  });

  it("defaults to light and preserves stable singleton identity", () => {
    expect(resolveTheme(null).scheme).toBe("light");
    expect(resolveTheme(undefined).scheme).toBe("light");
    expect(resolveTheme("dark")).toBe(resolveTheme("dark"));
    expect(resolveTheme("light").colors).toBe(resolveTheme("light").colors);
  });

  it("carries the shared spacing, radii, metrics, density and hit-target contract", () => {
    const theme = resolveTheme("light");
    expect(theme.spacing["4"]).toBe(16);
    expect(theme.radii.md).toBe(7);
    expect(theme.metrics.row).toBe(44);
    expect(theme.metrics.control).toBe(34);
    expect(theme.density.compact.row).toBe(38);
    expect(theme.borders.hairline).toBe(1);
    // The page margin travels on the theme like every other shared scalar, so
    // a screen reaches for `theme.pageMargin` instead of retyping 18.
    expect(theme.pageMargin).toBe(18);
    expect(theme.targetMin.coarse).toBe(48);
    expect(theme.targetMin.fine).toBe(32);
  });

  it("spends no hue — the accent is ink, same on both themes' action role", () => {
    expect(resolveTheme("light").colors.accent).toBe(
      resolveTheme("light").colors.text
    );
    expect(resolveTheme("dark").colors.accent).toBe(
      resolveTheme("dark").colors.text
    );
  });
});

describe("navigation theme lowering", () => {
  it("tracks the generated palette", () => {
    expect(navThemeFor("dark").dark).toBe(true);
    expect(navThemeFor("light").dark).toBe(false);
    expect(navThemeFor("dark").colors.background).toBe(darkPalette.bg);
    expect(navThemeFor("light").colors.text).toBe(lightPalette.text);
  });

  it("maps navigation weights onto the loaded sans family — no bold rung", () => {
    expect(navThemes.light.fonts.regular.fontFamily).toBe(
      "InstrumentSans_400Regular"
    );
    expect(navThemes.dark.fonts.bold.fontFamily).toBe(
      "InstrumentSans_500Medium"
    );
  });
});
