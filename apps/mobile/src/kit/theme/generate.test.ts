import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildTheme, renderTokensModule } from "./generate";

const GENERATED = fileURLToPath(
  new URL("tokens.generated.ts", import.meta.url)
);

describe("typed native lowering", () => {
  const theme = buildTheme();

  it("returns concrete light and dark values with identical role keys", () => {
    expect(Object.keys(theme.light).sort()).toStrictEqual(
      Object.keys(theme.dark).sort()
    );
    for (const value of Object.values(theme.light)) {
      expect(value).not.toMatch(/var\(|calc\(|color-mix\(/u);
    }
    for (const value of Object.values(theme.dark)) {
      expect(value).not.toMatch(/var\(|calc\(|color-mix\(/u);
    }
  });

  it("keeps the shared scale and native accessibility floors", () => {
    expect(theme.spacing["4"]).toBe(16);
    expect(theme.radii.md).toBe(6);
    expect(theme.radii.pill).toBe(999);
    expect(theme.targetMin).toStrictEqual({ coarse: 48, fine: 32 });
    expect(theme.type.body.fontSize).toBe(17);
    expect(theme.type.body.lineHeight).toBe(24);
    expect(theme.type.greeting.family).toBe("serif");
  });

  it("uses the one action accent and no legacy display face", () => {
    expect(theme.light.accent).toBe("#3EC8B4");
    expect(theme.dark.accent).toBe("#3EC8B4");
    expect(theme.fonts.serif.semibold).toBe("PlayfairDisplay_600SemiBold");
    expect(theme.fonts).not.toHaveProperty("title");
  });

  it("lowers every legal product accent into the native surface", () => {
    expect(Object.keys(theme.accentThemes).sort()).toStrictEqual([
      "blue",
      "ochre",
      "rose",
      "teal",
      "violet",
    ]);
    expect(theme.accentThemes.violet.light.accent).toBe("#7C5BD9");
    expect(theme.accentThemes.violet.dark.accent).toBe("#7C5BD9");
    expect(theme.accentThemes.ochre.light.bgSel).toContain("rgba(");
  });

  it("renders deterministic formatter-shaped source", () => {
    const a = renderTokensModule(theme, "@centraid/design#toNativeTheme");
    const b = renderTokensModule(theme, "@centraid/design#toNativeTheme");
    expect(a).toBe(b);
    expect(a).toContain("export const lightPalette");
    expect(a).toContain("export const type");
    expect(a).toContain("Geist_400Regular");
    expect(a).not.toContain("SpaceGrotesk");
    expect(a).not.toContain("parseTokensCss");
    expect(a).toContain("export const accentThemes");
  });

  it("keeps the checked-in native module fresh", () => {
    expect(readFileSync(GENERATED, "utf8")).toBe(
      renderTokensModule(theme, "@centraid/design#toNativeTheme")
    );
  });
});
