import { describe, expect, test } from "vitest";

import { palette, paletteText } from "./palette.js";
import {
  ICON_CHIP_TINT,
  TILE_VARIANTS,
  iconChipFinish,
  tileFinish,
} from "./tile.js";
import type { TileVariant } from "./tile.js";

const HUES = Object.values(palette);

function hexSamples(count: number, seed: number): string[] {
  let state = seed >>> 0;
  const byte = (): number => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state >>> 24;
  };
  return Array.from(
    { length: count },
    () =>
      `#${[byte(), byte(), byte()].map((n) => n.toString(16).padStart(2, "0")).join("")}`
  );
}

function rgbaChannels(value: string): [number, number, number, number] {
  const m = /^rgba\((?<r>\d+),(?<g>\d+),(?<b>\d+),(?<a>[\d.]+)\)$/u.exec(value);
  expect(m, `not an rgba() value: ${value}`).not.toBeNull();
  const g = m?.groups as Record<string, string>;
  return [Number(g.r), Number(g.g), Number(g.b), Number(g.a)];
}

const SWEEP = [...HUES, ...hexSamples(60, 65650), "#000000", "#ffffff"];

describe("tile variants", () => {
  test("the exported variant list is exactly the set tileFinish handles", () => {
    expect(new Set(TILE_VARIANTS)).toStrictEqual(
      new Set<TileVariant>(["solid", "gradient", "glassy", "flat"])
    );
    expect(TILE_VARIANTS).toHaveLength(4);
  });

  test("every variant of every hue produces a paintable finish", () => {
    for (const color of SWEEP) {
      for (const variant of TILE_VARIANTS) {
        const finish = tileFinish(color, variant);
        expect(finish.background, `${color}/${variant}`).not.toBe("");
        expect(finish.backgroundColor, `${color}/${variant}`).not.toContain(
          "gradient"
        );
        expect(finish.glyphColor, `${color}/${variant}`).not.toBe("");
      }
    }
  });

  test("the four variants are visually distinct for any hue", () => {
    for (const color of SWEEP) {
      const backgrounds = TILE_VARIANTS.map(
        (v) => tileFinish(color, v).background
      );
      expect(new Set(backgrounds).size, color).toBe(TILE_VARIANTS.length);
    }
  });

  test("solid paints the hue itself, unmodified, with a white glyph", () => {
    for (const color of SWEEP) {
      const finish = tileFinish(color, "solid");
      expect(finish.background, color).toBe(color);
      expect(finish.backgroundColor, color).toBe(color);
      expect(finish.glyphColor, color).toBe("#ffffff");
      expect(finish.backdropFilter, color).toBeUndefined();
    }
  });

  test("gradient darkens top→bottom and keeps the hue as the RN fallback", () => {
    for (const color of SWEEP) {
      const finish = tileFinish(color, "gradient");
      expect(finish.backgroundColor, color).toBe(color);
      const stops = [...finish.background.matchAll(/#[0-9a-f]{6}/giu)].map(
        (m) => m[0]
      );
      expect(stops, color).toHaveLength(2);
      expect(stops[0], color).toBe(color);
      const channel = (h: string, i: number): number =>
        parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
      for (const i of [0, 1, 2]) {
        const from = channel(color, i);
        const to = channel(stops[1] as string, i);
        expect(to, `${color}[${i}]`).toBeLessThanOrEqual(from);
        expect(to, `${color}[${i}]`).toBeGreaterThanOrEqual(0);
        expect(to, `${color}[${i}]`).toBe(Math.max(0, from - 36));
      }
      expect(finish.glyphColor, color).toBe("#ffffff");
    }
  });

  test("shading clamps at black rather than wrapping around", () => {
    const finish = tileFinish("#000000", "gradient");
    const stops = [...finish.background.matchAll(/#[0-9a-f]{6}/giu)].map(
      (m) => m[0]
    );
    expect(stops[1]).toBe("#000000");
    const dark = tileFinish("#0a0a0a", "gradient").background;
    expect(dark).toContain("#000000");
    expect(dark).not.toMatch(/#-|NaN/u);
  });

  test("every shaded channel stays a two-digit hex byte", () => {
    for (const color of SWEEP) {
      const shaded = [
        ...tileFinish(color, "gradient").background.matchAll(/#[0-9a-f]{6}/giu),
      ].map((m) => m[0]);
      expect(shaded[1], color).toMatch(/^#[0-9a-f]{6}$/u);
    }
  });

  test("glassy and flat tint the hue at their own alpha and keep it as the glyph", () => {
    for (const color of SWEEP) {
      const expected = [
        parseInt(color.slice(1, 3), 16),
        parseInt(color.slice(3, 5), 16),
        parseInt(color.slice(5, 7), 16),
      ];
      for (const [variant, alpha] of [
        ["glassy", 0.22],
        ["flat", 0.14],
      ] as const) {
        const finish = tileFinish(color, variant);
        const [r, g, b, a] = rgbaChannels(finish.background);
        expect([r, g, b], `${color}/${variant}`).toStrictEqual(expected);
        expect(a, `${color}/${variant}`).toBe(alpha);
        expect(finish.backgroundColor, `${color}/${variant}`).toBe(
          finish.background
        );
        expect(finish.glyphColor, `${color}/${variant}`).toBe(color);
      }
    }
  });

  test("glassy is the more opaque of the two tints and the only blurred one", () => {
    const color = "#2ea098";
    const glassy = tileFinish(color, "glassy");
    const flat = tileFinish(color, "flat");
    expect(rgbaChannels(glassy.background)[3]).toBeGreaterThan(
      rgbaChannels(flat.background)[3]
    );
    expect(glassy.backdropFilter).toBeTruthy();
    expect(flat.backdropFilter).toBeUndefined();
  });

  test("a non-hex colour passes through instead of producing NaN paint", () => {
    for (const bad of ["currentColor", "#fff", "rgb(1,2,3)", ""]) {
      for (const variant of TILE_VARIANTS) {
        const finish = tileFinish(bad, variant);
        expect(
          `${finish.background}${finish.backgroundColor}${finish.boxShadow ?? ""}`,
          `${bad}/${variant}`
        ).not.toMatch(/NaN|undefined/u);
      }
      expect(tileFinish(bad, "flat").background).toBe(bad);
      expect(tileFinish(bad, "gradient").background).toContain(bad);
    }
  });

  test("uppercase hex is accepted and parsed identically to lowercase", () => {
    for (const color of SWEEP) {
      expect(tileFinish(color.toUpperCase(), "flat").background, color).toBe(
        tileFinish(color, "flat").background
      );
    }
  });

  test("every variant that layers over content carries an inset hairline", () => {
    for (const variant of TILE_VARIANTS) {
      expect(tileFinish("#4950f6", variant).boxShadow, variant).toContain(
        "inset"
      );
    }
  });
});

describe("single-tone app mark finish", () => {
  test("uses the solved text rung for every built-in app hue", () => {
    for (const [key, hue] of Object.entries(palette)) {
      expect(iconChipFinish(hue, "#ffffff", "light").markColor).toBe(
        paletteText.light[key as keyof typeof paletteText.light]
      );
      expect(iconChipFinish(hue, "#101010", "dark").markColor).toBe(
        paletteText.dark[key as keyof typeof paletteText.dark]
      );
    }
  });

  test("keeps arbitrary manifest hues renderable", () => {
    const finish = iconChipFinish("#167f8f", "#ffffff", "light");
    expect(finish.markColor).toBe("#167f8f");
    expect(ICON_CHIP_TINT.light).toBe(0.13);
    expect(ICON_CHIP_TINT.dark).toBe(0.2);
  });
});
