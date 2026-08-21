// The app identity ring is defined in OKLCH and shipped as sRGB hex, so the
// conversion is not measurement machinery — it is the palette. A drift here
// moves every app's colour at once, silently, in a direction no test that only
// reads the emitted hex could name.

import { describe, expect, test } from "vitest";

import { contrastRatio, parseColor, rgbToHsl } from "./color.js";
import { oklchToHex } from "./oklab.js";

describe("oklch → sRGB", () => {
  // Reference values from the CSS Color 4 conversion of the sRGB primaries.
  // These are exact: the primaries sit on the gamut boundary, so any error in
  // the matrices or the transfer function shows up immediately.
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
    // `oklch(0.5 0 0)` is perceptual mid-grey, which is NOT `#808080` —
    // sRGB's own midpoint is lighter than half the perceived lightness.
    expect(oklchToHex(0.5, 0, 0)).toBe("#636363");
  });

  test("clamps out-of-gamut chroma without moving the hue", () => {
    // Naive channel clipping shifts the hue sideways, which would silently
    // re-point an app's identity. Bisecting chroma keeps lightness and hue.
    const requested = 210;
    const clamped = oklchToHex(0.5, 0.6, requested);
    const inGamut = oklchToHex(0.5, 0.09, requested);
    const hue = (value: string): number => rgbToHsl(parseColor(value).rgb)[0];
    expect(Math.abs(hue(clamped) - hue(inGamut))).toBeLessThan(6);
    expect(parseColor(clamped).rgb.every((c) => c >= 0 && c <= 255)).toBe(true);
  });

  test("holds perceived weight while the hue sweeps the wheel", () => {
    // The property that makes the identity ring a system rather than eight
    // swatches: at one OKLCH lightness and one chroma, no app can be louder
    // than another. sRGB luminance is not the measure — it is hue-weighted by
    // construction — so this is measured as contrast against the page, which
    // is what actually decides how loud a mark reads.
    const ratios = [0, 28, 70, 150, 210, 255, 290, 320].map((hue) =>
      contrastRatio(oklchToHex(0.5, 0.09, hue), "#FDFDFC")
    );
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(2);
  });
});
