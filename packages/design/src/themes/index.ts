// Centraid — themes barrel.
// Collects every preset under this folder into a typed registry +
// ordered display list. The desktop/web shell drinks from here via CSS vars
// (`toCss()`). Mobile does NOT import these presets: it lowers the blueprint
// emit instead — `apps/mobile/scripts/generate-theme.ts` runs
// `toBlueprintCss()` through `src/kit/theme/generate.ts` into the checked-in
// `src/kit/theme/tokens.generated.ts`, which `useTheme()` reads.

import { darkTheme, lightTheme } from "./centraid";

export type { Theme } from "./shared";
export {
  ACCENT_HOVER,
  BRAND_DARK,
  ACCENT_HOVER_DARK,
  ACCENT_LIGHT,
  ACCENT_LIGHT_DARK,
  BRAND,
  DUR_ENTRY,
  DUR_STATE,
  EASE,
  EASE_ENTRY,
  LINK,
  LINK_DARK,
  NET,
  NET_DARK,
  RING,
  RING_DARK,
  SURFACE_TONE_NAMES,
  SURFACE_TONES,
} from "./shared";
export type { SurfaceTone } from "./shared";

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
// resolved kind first.
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
