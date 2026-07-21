// Pure theme resolver — no React / React-Native imports, so it stays unit
// testable in the node vitest env. `useTheme.ts` wraps this with
// `useColorScheme()`; everything dark-mode actually needs is here.

import type { Theme as NavigationTheme } from '@react-navigation/native';
import { lightPalette, darkPalette, radii, spacing, fonts } from './tokens.generated';

export type Scheme = 'light' | 'dark';

// The generated palettes plus a derived `ink4` — tokens.css has no `--ink-4`,
// but the app uses a fourth, fainter ink (e.g. the home pager dots), so we
// derive it here as a low-alpha ink rather than snapping to ink3.
export type ThemeColors = Record<keyof typeof lightPalette, string> & { ink4: string };

export interface ThemeValue {
  scheme: Scheme;
  colors: ThemeColors;
  radii: typeof radii;
  spacing: typeof spacing;
  fonts: typeof fonts;
}

// The "Centraid Mobile" design ships a warm, solar light theme — a parchment
// cream canvas (its `screenBg` is #F1ECE1) rather than the shared kit's cool
// near-white. That warmth is specific to the phone, so we override the light
// ramp here (mobile-only) instead of touching the generated palette or the
// shared tokens.css that desktop + web read. Backgrounds, lines and inks are
// warmed to sit on the cream; the indigo `accent` and `danger` are unchanged.
// Dark mode already matches the design closely, so it passes through untouched.
const SOLAR_LIGHT: ThemeColors = {
  ...lightPalette,
  bg: '#f1ece1', // design screenBg — the solar cream canvas
  bgElev: '#fbf8f1', // warm off-white, lifts cards above the canvas
  bgSunken: '#e7dfcf', // deeper warm sand for search pills / inputs
  surface: '#fbf8f1',
  surface2: '#e7dfcf',
  ink: '#231f18', // warm near-black
  ink2: '#645c4e',
  inkSoft: '#645c4e',
  muted: '#645c4e',
  ink3: '#938a78',
  inkFaint: '#938a78',
  line: 'rgba(60, 48, 22, 0.1)',
  lineStrong: 'rgba(60, 48, 22, 0.18)',
  ink4: 'rgba(35, 31, 24, 0.28)',
};

const LIGHT_COLORS: ThemeColors = SOLAR_LIGHT;
const DARK_COLORS: ThemeColors = { ...darkPalette, ink4: 'rgba(237, 239, 242, 0.28)' };

// Frozen singletons per scheme so `colors` keeps a stable identity across
// renders — lets screens `useMemo(makeStyles, [colors])` without thrash.
const LIGHT: ThemeValue = { scheme: 'light', colors: LIGHT_COLORS, radii, spacing, fonts };
const DARK: ThemeValue = { scheme: 'dark', colors: DARK_COLORS, radii, spacing, fonts };

export function resolveTheme(scheme: Scheme | null | undefined): ThemeValue {
  return scheme === 'dark' ? DARK : LIGHT;
}

// React Navigation theme — feeds NavigationContainer so headers, card
// backgrounds and default text follow the palette. Font weights map onto the
// loaded Geist families (native can't combine fontFamily + fontWeight).
function navTheme(t: ThemeValue): NavigationTheme {
  const { colors } = t;
  return {
    dark: t.scheme === 'dark',
    colors: {
      background: colors.bg,
      border: colors.line,
      card: colors.bgElev,
      notification: colors.accent,
      primary: colors.accent,
      text: colors.ink,
    },
    fonts: {
      regular: { fontFamily: fonts.sans.regular, fontWeight: '400' },
      medium: { fontFamily: fonts.sans.medium, fontWeight: '500' },
      bold: { fontFamily: fonts.sans.semibold, fontWeight: '600' },
      heavy: { fontFamily: fonts.sans.semibold, fontWeight: '600' },
    },
  };
}

export const navThemes: Record<Scheme, NavigationTheme> = {
  light: navTheme(LIGHT),
  dark: navTheme(DARK),
};

export function navThemeFor(scheme: Scheme | null | undefined): NavigationTheme {
  return scheme === 'dark' ? navThemes.dark : navThemes.light;
}
