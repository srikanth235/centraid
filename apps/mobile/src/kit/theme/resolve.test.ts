import { describe, expect, it } from 'vitest';
import { navThemeFor, navThemes, resolveTheme } from './resolve';
import { darkPalette, lightPalette } from './tokens.generated';

describe('resolveTheme', () => {
  it('selects the palette by scheme', () => {
    expect(resolveTheme('light').scheme).toBe('light');
    expect(resolveTheme('light').colors.bg).toBe(lightPalette.bg);
    expect(resolveTheme('dark').scheme).toBe('dark');
    expect(resolveTheme('dark').colors.bg).toBe(darkPalette.bg);
    expect(resolveTheme('dark').colors.bg).not.toBe(resolveTheme('light').colors.bg);
  });

  it('defaults to light for null/undefined (no OS preference)', () => {
    expect(resolveTheme(null).scheme).toBe('light');
    expect(resolveTheme(undefined).scheme).toBe('light');
  });

  it('derives ink4, which the kit tokens lack', () => {
    expect(resolveTheme('light').colors.ink4).toMatch(/^rgba\(/);
    expect(resolveTheme('dark').colors.ink4).not.toBe(resolveTheme('light').colors.ink4);
  });

  it('returns a stable colors identity per scheme (memo-friendly)', () => {
    expect(resolveTheme('dark').colors).toBe(resolveTheme('dark').colors);
    expect(resolveTheme('light').colors).toBe(resolveTheme('light').colors);
  });

  it('carries spacing, radii and fonts through', () => {
    const t = resolveTheme('light');
    expect(t.spacing[4]).toBe(16);
    expect(t.radii.card).toBe(14);
    expect(t.fonts.sans.regular).toBe('Geist_400Regular');
  });
});

describe('navThemeFor', () => {
  it('flips the dark flag and tracks the palette', () => {
    expect(navThemeFor('dark').dark).toBe(true);
    expect(navThemeFor('light').dark).toBe(false);
    expect(navThemeFor('dark').colors.background).toBe(darkPalette.bg);
    expect(navThemeFor('light').colors.text).toBe(lightPalette.ink);
  });

  it('maps nav fonts onto the loaded Geist families', () => {
    expect(navThemes.light.fonts.regular.fontFamily).toBe('Geist_400Regular');
    expect(navThemes.dark.fonts.bold.fontFamily).toBe('Geist_600SemiBold');
  });
});
