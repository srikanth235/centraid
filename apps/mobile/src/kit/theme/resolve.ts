// Typed native theme resolver.  `tokens.generated.ts` is the checked-in
// lowering of @centraid/design/src/native.ts; this module only selects the
// already-concrete light or dark object.
//
// The Binding Layer collapsed the product accent to one ink value — there is
// no owner-selectable hue any more, so this module (unlike its predecessor)
// takes no accent key.

import type { Theme as NavigationTheme } from "@react-navigation/native";

import {
  darkPalette,
  density,
  durations,
  fonts,
  lightPalette,
  metrics,
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
  metrics: typeof metrics;
  density: typeof density;
  fonts: typeof fonts;
  type: typeof type;
  targetMin: typeof targetMin;
  durations: typeof durations;
}

function themeFor(scheme: Scheme): ThemeValue {
  const colors: ThemeColors = scheme === "dark" ? darkPalette : lightPalette;
  return {
    colors,
    density,
    durations,
    fonts,
    metrics,
    radii,
    scheme,
    spacing,
    targetMin,
    type,
  };
}

const CACHE = new Map<Scheme, ThemeValue>();

export function resolveTheme(scheme: Scheme | null | undefined): ThemeValue {
  const resolvedScheme = scheme === "dark" ? "dark" : "light";
  const cached = CACHE.get(resolvedScheme);
  if (cached) return cached;
  const theme = themeFor(resolvedScheme);
  CACHE.set(resolvedScheme, theme);
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
      bold: { fontFamily: fonts.sans.medium, fontWeight: "500" },
      heavy: { fontFamily: fonts.sans.medium, fontWeight: "500" },
    },
  };
}

export const navThemes: Record<Scheme, NavigationTheme> = {
  dark: navTheme(resolveTheme("dark")),
  light: navTheme(resolveTheme("light")),
};

export function navThemeFor(
  scheme: Scheme | null | undefined
): NavigationTheme {
  return scheme === "dark" ? navThemes.dark : navThemes.light;
}
