// Mobile design boundary. Canonical values come directly from
// `@centraid/design/native`; `native.ts` contains the two unavoidable React
// Native adaptations (Expo font family names and em-to-point tracking).

export {
  borders,
  density,
  durations,
  family,
  fonts,
  metrics,
  pageMargin,
  radii,
  spacing,
  t,
  targetMin,
  type,
} from "./native";
export type { NativeTextRole } from "./native";

export { useTheme } from "./useTheme";
export { navThemeFor, resolveTheme } from "./resolve";
export type { Scheme, ThemeColors, ThemeValue } from "./resolve";

export {
  hydrateAppearance,
  resolveScheme,
  setAppearance,
  useAppearance,
} from "./appearance";
export type { Appearance } from "./appearance";
