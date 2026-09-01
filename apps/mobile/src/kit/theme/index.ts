// Mobile design boundary. Canonical values come directly from
// `@centraid/design/native`; `native.ts` contains the unavoidable React Native
// adaptations (Expo font family names, em-to-point tracking, and the CSS
// shadow strings lowered to RN shadow props).

export {
  borders,
  density,
  durations,
  family,
  fonts,
  metrics,
  pageMargin,
  popoverShadow,
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
