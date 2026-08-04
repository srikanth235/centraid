// The Binding Layer's "reserve a band" promise (docs/design/handoff-binding-
// layer/README.md, "App identity hues"): a third-party app hue is clamped to
// `C ≤ .09` and the built-in lightness rung, so no vendor can out-shout the
// system. `IDENTITY_CHROMA` already held the eight BUILT-IN hues to that
// ceiling; `clampIdentityHue` is the function a SUBMITTED (arbitrary,
// untrusted) hue must pass through before it is ever admitted.

import { describe, expect, test } from "vitest";

import { oklchToHex } from "./oklab";
import {
  APP_HUES,
  clampIdentityHue,
  IDENTITY_CHROMA,
  palette,
  paletteDark,
} from "./palette";

describe(clampIdentityHue, () => {
  test("a submission at the system's own chroma reproduces the built-in ring exactly", () => {
    // Every shipped app hue run back through the clamp must land on the
    // exact hex the built-in ring already publishes — the clamp is not a
    // second, slightly-different formula for the eight names that already
    // exist.
    for (const [key, hue] of Object.entries(APP_HUES)) {
      expect(
        clampIdentityHue({ chroma: IDENTITY_CHROMA, hue }, "light"),
        key
      ).toBe(palette[key as keyof typeof palette]);
      expect(
        clampIdentityHue({ chroma: IDENTITY_CHROMA, hue }, "dark"),
        key
      ).toBe(paletteDark[key as keyof typeof paletteDark]);
    }
  });

  test("an over-saturated submission is clamped down to the ceiling, never raised", () => {
    // A vendor asking for triple the system's chroma at hue 12 (Chat's hue)
    // must land on exactly the chroma ceiling, not partway there and not at
    // its own requested value.
    const wildly = clampIdentityHue({ chroma: 0.4, hue: 12 }, "light");
    const atCeiling = oklchToHex(0.5, IDENTITY_CHROMA, 12);
    expect(wildly).toBe(atCeiling);
    // And explicitly not the over-saturated hex a naive pass-through would
    // have produced.
    expect(wildly).not.toBe(oklchToHex(0.5, 0.4, 12));
  });

  test("a submission under the ceiling is left alone rather than raised to it", () => {
    const modest = clampIdentityHue({ chroma: 0.03, hue: 200 }, "light");
    expect(modest).toBe(oklchToHex(0.5, 0.03, 200));
    expect(modest).not.toBe(oklchToHex(0.5, IDENTITY_CHROMA, 200));
  });

  test("an out-of-gamut chroma at the ceiling still resolves inside sRGB", () => {
    // The ceiling itself, at every degree of the wheel, must stay a real hex
    // — the same guarantee `oklchToHex`'s own bisection gives the built-in
    // ring, now exercised through the clamp's own entry point.
    for (let hue = 0; hue < 360; hue += 15) {
      const hex = clampIdentityHue({ chroma: 0.4, hue }, "light");
      expect(hex, `hue ${hue}`).toMatch(/^#[0-9a-f]{6}$/iu);
    }
  });

  test("an out-of-range hue wraps onto the wheel instead of going undefined", () => {
    expect(clampIdentityHue({ hue: -30 }, "light")).toBe(
      clampIdentityHue({ hue: 330 }, "light")
    );
    expect(clampIdentityHue({ hue: 390 }, "light")).toBe(
      clampIdentityHue({ hue: 30 }, "light")
    );
  });

  test("no chroma defaults to the ceiling, not to zero", () => {
    expect(clampIdentityHue({ hue: 210 }, "light")).toBe(
      oklchToHex(0.5, IDENTITY_CHROMA, 210)
    );
  });

  test("dark scheme uses the dark lightness rung, not the light one", () => {
    const light = clampIdentityHue({ hue: 70 }, "light");
    const dark = clampIdentityHue({ hue: 70 }, "dark");
    expect(dark).not.toBe(light);
    expect(dark).toBe(oklchToHex(0.72, IDENTITY_CHROMA, 70));
  });
});
