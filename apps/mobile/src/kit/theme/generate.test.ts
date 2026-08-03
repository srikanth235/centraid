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
      expect(value).not.toMatch(/var\(|calc\(|color-mix\(|oklch\(/u);
    }
    for (const value of Object.values(theme.dark)) {
      expect(value).not.toMatch(/var\(|calc\(|color-mix\(|oklch\(/u);
    }
  });

  it("keeps the shared scale, metrics, density and native accessibility floors", () => {
    expect(theme.spacing["4"]).toBe(16);
    expect(theme.radii.md).toBe(7);
    expect(theme.radii.pill).toBe(999);
    expect(theme.metrics.control).toBe(34);
    expect(theme.metrics.row).toBe(44);
    expect(theme.metrics.stem).toBe(92);
    expect(theme.density.comfortable.row).toBe(44);
    expect(theme.density.dense.row).toBe(34);
    expect(theme.targetMin).toStrictEqual({ coarse: 48, fine: 32 });
    expect(theme.type.body.fontSize).toBe(17);
  });

  it("spends no hue — the accent is ink, and there is no legacy display face", () => {
    expect(theme.light.accent).toBe(theme.light.text);
    expect(theme.dark.accent).toBe(theme.dark.text);
    expect(theme.fonts.serif.regular).toBe("SourceSerif4_400Regular");
    expect(theme.fonts.display.regular).toBe("InstrumentSerif_400Regular");
    expect(theme.fonts).not.toHaveProperty("title");
  });

  it("carries the net and link roles, and never carries an accentThemes matrix", () => {
    expect(theme.light.net).toBeTruthy();
    expect(theme.light.link).toBeTruthy();
    expect(theme).not.toHaveProperty("accentThemes");
  });

  it("renders deterministic formatter-shaped source", () => {
    const a = renderTokensModule(theme, "@centraid/design#toNativeTheme");
    const b = renderTokensModule(theme, "@centraid/design#toNativeTheme");
    expect(a).toBe(b);
    expect(a).toContain("export const lightPalette");
    expect(a).toContain("export const type");
    expect(a).toContain("export const metrics");
    expect(a).toContain("export const density");
    expect(a).toContain("InstrumentSans_400Regular");
    expect(a).not.toContain("Geist");
    expect(a).not.toContain("JetBrainsMono");
    expect(a).not.toContain("PlayfairDisplay");
    expect(a).not.toContain("SpaceGrotesk");
    expect(a).not.toContain("parseTokensCss");
    expect(a).not.toContain("accentThemes");
  });

  it("keeps the checked-in native module fresh", () => {
    expect(readFileSync(GENERATED, "utf8")).toBe(
      renderTokensModule(theme, "@centraid/design#toNativeTheme")
    );
  });
});
