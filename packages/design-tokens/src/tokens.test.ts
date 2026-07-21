/**
 * Minimal design-tokens coverage (#496 H3).
 * Tokens are a known trap zone (hardcoded CSS drift); pin brand + palette shape.
 */
import { expect, test } from 'vitest';
import { BRAND, palette, radii, spacing, themes } from './index.js';

test('brand teal is a stable hex identity color', () => {
  expect(BRAND).toMatch(/^#[0-9a-fA-F]{6}$/);
});

test('palette exposes required color keys used by shell chrome', () => {
  expect(palette.forest).toMatch(/^#/);
  expect(palette.teal).toMatch(/^#/);
  expect(Object.keys(palette).length).toBeGreaterThan(5);
});

test('light and dark themes both define background and ink', () => {
  expect(themes.light.bg).toBeTruthy();
  expect(themes.dark.bg).toBeTruthy();
  expect(themes.light.ink).toBeTruthy();
  expect(themes.dark.ink).toBeTruthy();
});

test('spacing and radii scales are non-empty', () => {
  expect(Object.keys(spacing).length).toBeGreaterThan(0);
  expect(Object.keys(radii).length).toBeGreaterThan(0);
});
