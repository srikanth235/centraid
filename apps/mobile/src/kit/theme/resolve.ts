// Typed native theme resolver.  `tokens.generated.ts` is the checked-in
// lowering of @centraid/design/src/native.ts; this module only selects the
// already-concrete light or dark object.

import type { Theme as NavigationTheme } from "@react-navigation/native";

import type { AccentKey } from "@centraid/design";

import {
  accentThemes,
  darkPalette,
  durations,
  fonts,
  lightPalette,
  radii,
  spacing,
  targetMin,
  type,
} from "./tokens.generated";

export type Scheme = "light" | "dark";

export type ThemeColors = {
  [Key in keyof typeof lightPalette]: string;
};

export interface ThemeValue {
  scheme: Scheme;
  colors: ThemeColors;
  radii: typeof radii;
  spacing: typeof spacing;
  fonts: typeof fonts;
  type: typeof type;
  targetMin: typeof targetMin;
  durations: typeof durations;
}

function themeFor(scheme: Scheme, accentKey: AccentKey): ThemeValue {
  const colors: ThemeColors =
    accentKey === "teal"
      ? scheme === "dark"
        ? darkPalette
        : lightPalette
      : (accentThemes[accentKey]?.[scheme] ??
        (scheme === "dark" ? darkPalette : lightPalette));
  return {
    colors,
    durations,
    fonts,
    radii,
    scheme,
    spacing,
    targetMin,
    type,
  };
}

const CACHE = new Map<string, ThemeValue>();

export function resolveTheme(
  scheme: Scheme | null | undefined,
  accentKey: AccentKey = "teal"
): ThemeValue {
  const resolvedScheme = scheme === "dark" ? "dark" : "light";
  const cacheKey = `${resolvedScheme}:${accentKey}`;
  const cached = CACHE.get(cacheKey);
  if (cached) return cached;
  const theme = themeFor(resolvedScheme, accentKey);
  CACHE.set(cacheKey, theme);
  return theme;
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
      medium: { fontFamily: fonts.sans.medium, fontWeight: "500" },
      bold: { fontFamily: fonts.sans.semibold, fontWeight: "600" },
      heavy: { fontFamily: fonts.sans.semibold, fontWeight: "600" },
    },
  };
}

export const navThemes: Record<Scheme, NavigationTheme> = {
  dark: navTheme(resolveTheme("dark")),
  light: navTheme(resolveTheme("light")),
};

export function navThemeFor(
  scheme: Scheme | null | undefined,
  accentKey: AccentKey = "teal"
): NavigationTheme {
  if (accentKey === "teal")
    return scheme === "dark" ? navThemes.dark : navThemes.light;
  return navTheme(resolveTheme(scheme, accentKey));
}
