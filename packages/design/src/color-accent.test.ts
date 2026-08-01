// The accent ramp shipped hand-picked variants once, and they drifted off
// their own hue — a teal accent with a green "deep", a rose accent with a
// violet "light". These assert the properties that made that possible.

import { describe, expect, test } from "vitest";

import { accentRamp, contrastRatio, parseColor, rgbToHsl } from "./color";
import { palette } from "./palette";
import { ACCENT_DEEP, ACCENT_LIGHT, ACCENT_TEXT_LIGHT, BRAND } from "./themes";

const hueOf = (value: string): number => rgbToHsl(parseColor(value).rgb)[0];
const lightnessOf = (value: string): number =>
  rgbToHsl(parseColor(value).rgb)[2];

/** Circular distance in degrees — 359° and 1° are 2° apart, not 358°. */
function hueDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

describe("derived accent ramps", () => {
  const bases = Object.entries(palette);

  test.each(bases)("%s keeps every variant on the base hue", (_name, base) => {
    const ramp = accentRamp(base);
    const hue = hueOf(base);
    for (const variant of [ramp.light, ramp.deep, ramp.text]) {
      // 2° of slack for the rounding trip through 8-bit RGB.
      expect(hueDistance(hueOf(variant), hue)).toBeLessThanOrEqual(2);
    }
  });

  test.each(bases)("%s orders light > accent > deep", (_name, base) => {
    const ramp = accentRamp(base);
    expect(lightnessOf(ramp.light)).toBeGreaterThan(lightnessOf(ramp.accent));
    expect(lightnessOf(ramp.deep)).toBeLessThan(lightnessOf(ramp.accent));
  });

  test.each(bases)(
    "%s is legible as text on a light surface",
    (_name, base) => {
      // The whole reason `text` is a separate rung: the fill value is not it.
      expect(
        contrastRatio(accentRamp(base).text, "#FCFCFC")
      ).toBeGreaterThanOrEqual(4.5);
    }
  );

  test("the derived brand ramp agrees with the authored one", () => {
    // BRAND keeps hand-authored variants (they are the identity). If the
    // derivation ever diverges materially from them, one of the two is wrong.
    const derived = accentRamp(BRAND);
    for (const [derivedValue, authored] of [
      [derived.light, ACCENT_LIGHT],
      [derived.deep, ACCENT_DEEP],
      [derived.text, ACCENT_TEXT_LIGHT],
    ] as const) {
      expect(
        hueDistance(hueOf(derivedValue), hueOf(authored))
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(lightnessOf(derivedValue) - lightnessOf(authored))
      ).toBeLessThan(0.06);
    }
  });
});
