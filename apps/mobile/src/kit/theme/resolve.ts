// Scheme selection and navigation adaptation over the canonical native theme.

import type { Theme as NavigationTheme } from "@react-navigation/native";

import type { NativeColors, NativeScheme } from "@centraid/design/native";

import {
  borders,
  canonicalTheme,
  density,
  durations,
  fonts,
  metrics,
  pageMargin,
  radii,
  spacing,
  targetMin,
  type,
} from "./native";

export type Scheme = NativeScheme;
export type ThemeColors = NativeColors;

export interface ThemeValue {
  scheme: Scheme;
  colors: ThemeColors;
  radii: typeof radii;
  borders: typeof borders;
  spacing: typeof spacing;
  metrics: typeof metrics;
  pageMargin: typeof pageMargin;
  density: typeof density;
  fonts: typeof fonts;
  type: typeof type;
  targetMin: typeof targetMin;
  durations: typeof durations;
}

function themeFor(scheme: Scheme): ThemeValue {
  return {
    borders,
    colors: canonicalTheme(scheme).colors,
    density,
    durations,
    fonts,
    metrics,
    pageMargin,
    radii,
    scheme,
    spacing,
    targetMin,
    type,
  };
}

const THEMES: Record<Scheme, ThemeValue> = {
  dark: themeFor("dark"),
  light: themeFor("light"),
};

export function resolveTheme(scheme: Scheme | null | undefined): ThemeValue {
  return scheme === "dark" ? THEMES.dark : THEMES.light;
}

function navTheme(theme: ThemeValue): NavigationTheme {
  const { colors } = theme;
  return {
    dark: theme.scheme === "dark",
    colors: {
      background: colors.bg,
      border: colors.line,
      card: colors.bgElev,
      notification: colors.accent,
      primary: colors.accent,
      text: colors.text,
    },
    fonts: {
      regular: { fontFamily: fonts.sans.regular, fontWeight: "400" },
      medium: { fontFamily: fonts.sans.semibold, fontWeight: "600" },
      bold: { fontFamily: fonts.sans.semibold, fontWeight: "600" },
      heavy: { fontFamily: fonts.sans.semibold, fontWeight: "600" },
    },
  };
}

const NAV_THEMES: Record<Scheme, NavigationTheme> = {
  dark: navTheme(THEMES.dark),
  light: navTheme(THEMES.light),
};

export function navThemeFor(
  scheme: Scheme | null | undefined
): NavigationTheme {
  return scheme === "dark" ? NAV_THEMES.dark : NAV_THEMES.light;
}
