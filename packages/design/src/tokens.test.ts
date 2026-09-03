import { describe, expect, test } from "vitest";

import { BRAND, palette, radii, spacing, themes } from "./index.js";

describe("tokens", () => {
  test("the product mark is ink, and it is the primary text colour", () => {
    expect(BRAND).toMatch(/^#[0-9a-fA-F]{6}$/u);
    expect(BRAND).toBe(themes.light.text);
  });

  test("palette exposes required color keys used by app identity", () => {
    expect(palette.forest).toMatch(/^#/u);
    expect(palette.teal).toMatch(/^#/u);
    expect(Object.keys(palette).length).toBeGreaterThan(5);
  });

  test("light and dark themes both define background and text", () => {
    expect(themes.light.bg).toBeTruthy();
    expect(themes.dark.bg).toBeTruthy();
    expect(themes.light.text).toBeTruthy();
    expect(themes.dark.text).toBeTruthy();
  });

  test("spacing and radii scales are non-empty", () => {
    expect(Object.keys(spacing).length).toBeGreaterThan(0);
    expect(Object.keys(radii).length).toBeGreaterThan(0);
  });
});
