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

  it("carries the shared spacing, radii, type and hit-target contract", () => {
    const theme = resolveTheme("light");
    expect(theme.spacing["4"]).toBe(16);
    expect(theme.radii.md).toBe(6);
    expect(theme.type.body.fontSize).toBe(17);
    expect(theme.targetMin.coarse).toBe(48);
    expect(theme.targetMin.fine).toBe(32);
  });

  it("applies the owner's product accent to native action roles", () => {
    const violet = resolveTheme("light", "violet");
    expect(violet.colors.accent).toBe("#7C5BD9");
    expect(violet.colors.accent).not.toBe(lightPalette.accent);
    expect(resolveTheme("dark", "ochre").colors.accent).toBe("#B47B3F");
  });
});

describe("navigation theme lowering", () => {
  it("tracks the generated palette", () => {
    expect(navThemeFor("dark").dark).toBe(true);
    expect(navThemeFor("light").dark).toBe(false);
    expect(navThemeFor("dark").colors.background).toBe(darkPalette.bg);
    expect(navThemeFor("light").colors.text).toBe(lightPalette.text);
  });

  it("maps navigation weights onto the loaded sans family", () => {
    expect(navThemes.light.fonts.regular.fontFamily).toBe("Geist_400Regular");
    expect(navThemes.dark.fonts.bold.fontFamily).toBe("Geist_600SemiBold");
  });

  it("uses the selected product accent for navigation actions", () => {
    expect(navThemeFor("light", "rose").colors.primary).toBe("#E55772");
    expect(navThemeFor("light", "rose").colors.notification).toBe("#E55772");
  });
});
