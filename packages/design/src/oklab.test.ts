// OKLCH-defined identity ring; drift recolours every app silently.

import { describe, expect, test } from "vitest";

import { contrastRatio, parseColor, rgbToHsl } from "./color.js";
import { oklchToHex } from "./oklab.js";

describe("oklch → sRGB", () => {
  // Exact CSS Color 4 refs for the gamut-boundary primaries.
  test.each([
    ["#ff0000", 0.627_96, 0.257_68, 29.234],
    ["#00ff00", 0.866_44, 0.294_83, 142.495],
    ["#0000ff", 0.452_01, 0.313_21, 264.052],
  ])("resolves %s", (expected, lightness, chroma, hue) => {
    expect(oklchToHex(lightness, chroma, hue)).toBe(expected);
  });

  test("achromatic lightness maps to a neutral grey", () => {
    expect(oklchToHex(0, 0, 0)).toBe("#000000");
    expect(oklchToHex(1, 0, 0)).toBe("#ffffff");
    expect(oklchToHex(0.5, 0, 0)).toBe("#636363");
  });

  test("clamps out-of-gamut chroma without moving the hue", () => {
    // Bisecting chroma keeps hue.
    const requested = 210;
    const clamped = oklchToHex(0.5, 0.6, requested);
    const inGamut = oklchToHex(0.5, 0.09, requested);
    const hue = (value: string): number => rgbToHsl(parseColor(value).rgb)[0];
    expect(Math.abs(hue(clamped) - hue(inGamut))).toBeLessThan(6);
    expect(parseColor(clamped).rgb.every((c) => c >= 0 && c <= 255)).toBe(true);
  });

  test("holds perceived weight while the hue sweeps the wheel", () => {
    // Loudness = page contrast (sRGB luminance is hue-weighted).
    const ratios = [0, 28, 70, 150, 210, 255, 290, 320].map((hue) =>
      contrastRatio(oklchToHex(0.5, 0.09, hue), "#FDFDFC")
    );
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(2);
  });
});
