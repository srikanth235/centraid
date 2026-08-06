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
    // 240, the Binding Layer's reserved navigation band (#707/#708). This
    // asserted 92 — the width of the rail the stem replaced — and went on
    // passing because the mobile suite was resolving `@centraid/design` through
    // a `dist/` built before that change. It only failed once that dist was
    // rebuilt, so the number here was pinning a stale artefact rather than the
    // shared source. Mobile draws no stem, but it lowers the same metrics table,
    // and the whole point of the table is that one number means one thing.
    expect(theme.metrics.stem).toBe(240);
    expect(theme.density.comfortable.row).toBe(44);
    expect(theme.density.dense.row).toBe(34);
    expect(theme.targetMin).toStrictEqual({ coarse: 48, fine: 32 });
    // The one rule weight, a FULL point. `StyleSheet.hairlineWidth` is one
    // PHYSICAL pixel — 0.33pt on a 3× phone, a third of the handoff's
    // `border: 1px solid` — and the whole point of lowering the weight into a
    // token is that no screen has to remember that.
    expect(theme.borders).toStrictEqual({ hairline: 1 });
    // The page margin is its OWN scale (`R.margin:{d:32,m:18}`, handoff
    // :3356), not a `spacing` rung — 18 does not sit on the 4px gap ladder,
    // which is exactly why screens that had to hard-code it drifted to 16/20.
    expect(theme.pageMargin).toBe(18);
    expect(Object.values(theme.spacing)).not.toContain(theme.pageMargin);
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
    // The stage roles, including its own sunken rung (handoff :4479), are one
    // literal in both schemes — the media ground does not follow the theme.
    expect(theme.light.stageSunken).toBe("#1A1A19");
    expect(theme.dark.stageSunken).toBe(theme.light.stageSunken);
    // …and the corrected veil (handoff :5101), which DOES follow the theme.
    expect(theme.light.scrim).toBe("rgba(26,24,21,0.3)");
    expect(theme.dark.scrim).toBe("rgba(0,0,0,0.62)");
    expect(theme).not.toHaveProperty("accentThemes");
  });

  it("renders deterministic formatter-shaped source", () => {
    const a = renderTokensModule(theme, "@centraid/design#toNativeTheme");
    const b = renderTokensModule(theme, "@centraid/design#toNativeTheme");
    expect(a).toBe(b);
    expect(a).toContain("export const lightPalette");
    expect(a).toContain("export const type");
    expect(a).toContain("export const metrics");
    expect(a).toContain("export const borders");
    expect(a).toContain("export const pageMargin");
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
