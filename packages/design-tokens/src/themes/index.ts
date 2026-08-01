// Centraid — themes barrel.
// Collects every preset under this folder into a typed registry +
// ordered display list. Both desktop (CSS vars via `toCss()`) and mobile
// (RN StyleSheet via `themes.light`) drink from this same well.

import { darkTheme, lightTheme } from "./centraid";

export type { Theme } from "./shared";
export { ACCENT_DEEP, ACCENT_LIGHT, ACCENT_TEXT_LIGHT, BRAND } from "./shared";

export { darkTheme, lightTheme } from "./centraid";

// Registry: every entry shows up in the desktop theme picker.
//
// INVARIANT — a registry key must equal its `kind`. Shell stylesheets key
// literally on `[data-theme='dark']` (`react/styles/toast.module.css`,
// `react/screens/SettingsConnectionsScreen.module.css`), so a dark preset
// registered under any other key would take the dark tokens while leaving
// those rules unfired — light chrome painted over a dark surface (#608 O).
// `themes.test.ts` pins the invariant; adding a third preset means either
// naming it `light`/`dark` (impossible) or moving those rules onto the
// resolved kind first. Mobile imports `themes.light` directly.
export const themes = {
  light: lightTheme,
  dark: darkTheme,
} as const;

export type ThemeName = keyof typeof themes;

/** Display metadata for the theme picker. Order = render order. */
export interface ThemePreset {
  name: ThemeName;
  label: string;
  kind: "light" | "dark";
}

export const THEME_PRESETS: ReadonlyArray<ThemePreset> = [
  { name: "light", label: "Centraid Light", kind: "light" },
  { name: "dark", label: "Centraid Dark", kind: "dark" },
];
