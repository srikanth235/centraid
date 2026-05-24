// Centraid — themes barrel.
// Collects every preset under this folder into a typed registry +
// ordered display list. Both desktop (CSS vars via `toCss()`) and mobile
// (RN StyleSheet via `themes.light`) drink from this same well.

import { airtableDarkTheme, airtableLightTheme } from './airtable';
import { darkTheme, lightTheme } from './centraid';
import { githubDarkTheme, githubLightTheme } from './github';
import { monokaiTheme } from './monokai';
import { nordTheme } from './nord';
import { notionDarkTheme, notionLightTheme } from './notion';
import { solarizedDarkTheme, solarizedLightTheme } from './solarized';

export type { Theme } from './_shared';
export { airtableDarkTheme, airtableLightTheme } from './airtable';
export { darkTheme, lightTheme } from './centraid';
export { githubDarkTheme, githubLightTheme } from './github';
export { monokaiTheme } from './monokai';
export { nordTheme } from './nord';
export { notionDarkTheme, notionLightTheme } from './notion';
export { solarizedDarkTheme, solarizedLightTheme } from './solarized';

// Registry: every entry shows up in the desktop theme picker. The first
// two keys (`light`, `dark`) double as the Centraid defaults — mobile
// imports `themes.light` directly, so do not remove or rename them.
export const themes = {
  light: lightTheme,
  dark: darkTheme,
  'notion-light': notionLightTheme,
  'notion-dark': notionDarkTheme,
  'airtable-light': airtableLightTheme,
  'airtable-dark': airtableDarkTheme,
  'github-light': githubLightTheme,
  'github-dark': githubDarkTheme,
  'solarized-light': solarizedLightTheme,
  'solarized-dark': solarizedDarkTheme,
  nord: nordTheme,
  monokai: monokaiTheme,
} as const;

export type ThemeName = keyof typeof themes;

/** Display metadata for the theme picker. Order = render order. */
export interface ThemePreset {
  name: ThemeName;
  label: string;
  kind: 'light' | 'dark';
}

export const THEME_PRESETS: ReadonlyArray<ThemePreset> = [
  { name: 'light', label: 'Centraid Light', kind: 'light' },
  { name: 'dark', label: 'Centraid Dark', kind: 'dark' },
  { name: 'notion-light', label: 'Notion Light', kind: 'light' },
  { name: 'notion-dark', label: 'Notion Dark', kind: 'dark' },
  { name: 'airtable-light', label: 'Airtable Light', kind: 'light' },
  { name: 'airtable-dark', label: 'Airtable Dark', kind: 'dark' },
  { name: 'github-light', label: 'GitHub Light', kind: 'light' },
  { name: 'github-dark', label: 'GitHub Dark', kind: 'dark' },
  { name: 'solarized-light', label: 'Solarized Light', kind: 'light' },
  { name: 'solarized-dark', label: 'Solarized Dark', kind: 'dark' },
  { name: 'nord', label: 'Nord', kind: 'dark' },
  { name: 'monokai', label: 'Monokai', kind: 'dark' },
];
