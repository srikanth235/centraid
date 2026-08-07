// Centraid — themes barrel.
// Collects every preset under this folder into a typed registry +
// ordered display list. The desktop/web shell drinks from here via CSS vars
// (`toCss()`). Mobile does NOT import these presets: it lowers the blueprint
// emit instead — `apps/mobile/scripts/generate-theme.ts` runs
// `toBlueprintCss()` through `src/kit/theme/generate.ts` into the checked-in
// `src/kit/theme/tokens.generated.ts`, which `useTheme()` reads.

import { darkTheme, lightTheme } from "./centraid";

// `PAGE` and `WALL` are deliberately NOT re-exported here (or from the
// package root). A consumer reaching for the literal instead of the `--bg`
// role is exactly the per-app page retune the one-page rule exists to
// prevent — see docs/traps/design-tokens.md, "There is ONE page, and an app
// does not retune it."
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
  ON_STAGE,
  ON_STAGE_SOFT,
  RING,
  RING_DARK,
  STAGE,
  STAGE_LINE,
  STAGE_SUNKEN,
} from "./shared";

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
