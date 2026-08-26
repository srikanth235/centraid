import { darkTheme, lightTheme } from "./centraid";

// No `PAGE`/`WALL` re-export: one-page rule (traps/design-tokens.md).
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

// INVARIANT #608: registry key must equal its kind; test-pinned.
export const themes = {
  light: lightTheme,
  dark: darkTheme,
} as const;

export type ThemeName = keyof typeof themes;

export interface ThemePreset {
  name: ThemeName;
  label: string;
  kind: "light" | "dark";
}

export const THEME_PRESETS: ReadonlyArray<ThemePreset> = [
  { name: "light", label: "Centraid Light", kind: "light" },
  { name: "dark", label: "Centraid Dark", kind: "dark" },
];
