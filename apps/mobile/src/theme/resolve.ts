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

const LIGHT_COLORS: ThemeColors = { ...lightPalette, ink4: 'rgba(26, 30, 40, 0.28)' };
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
