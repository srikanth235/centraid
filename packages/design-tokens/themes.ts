// Centraid — themes.
// Each theme is a flat record of presentational values: surfaces, ink,
// lines, shadows, the phone-frame bezel, and the device-wall gradient.
// Both desktop (CSS vars) and mobile (RN StyleSheet) drink from this same
// well — desktop via `toCss()` (see ./css.ts), mobile via direct property
// access (see apps/mobile/src/theme.ts).

import { palette } from './palette';
import type { Palette } from './palette';

// Single accent across both themes today. If we ever ship a "vivid" or
// "muted" accent, lift this into a per-theme override.
const ACCENT = '#8B5CF6';

export interface Theme {
  /** Single brand accent — FAB, sparkle, primary CTAs, focus rings. */
  accent: string;

  // Surfaces (low contrast → high contrast)
  bg: string;
  bgSunken: string;
  bgElev: string;
  bgApp: string;

  // Phone-frame bezel + inner ring. Drives `.phone` so the frame flips
  // automatically with the active theme.
  bezel: string;
  bezelInner: string;

  // Ink (text + icon foreground)
  ink: string;
  ink2: string;
  ink3: string;
  ink4: string;
  inkInv: string;

  // Hairlines
  line: string;
  lineStrong: string;

  // Shadows. Light theme tints shadows with the ink color (not pure black)
  // so they don't muddy on cool greys.
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;

  /**
   * Signature backdrop behind any "device" surface — preview pane, app
   * canvas. Two repeating-linear-gradients form a 1px crosshatch on top
   * of a vertical wall gradient. Desktop-only; mobile does not render
   * this (the phone IS the surface, not framed against a wall).
   */
  deviceWall: string;

  /** App-icon palette — same hues across themes by design. */
  palette: Palette;
}

export const lightTheme: Theme = {
  accent: ACCENT,
  bg: '#e8e9ec',
  bgApp: '#fafbfc',
  bgElev: '#f3f4f6',
  bgSunken: '#dcdee2',
  bezel: '#14181F',
  bezelInner: '#1f242d',
  deviceWall:
    'repeating-linear-gradient(0deg, transparent 0 23px, rgba(20,24,32,.04) 23px 24px), ' +
    'repeating-linear-gradient(90deg, transparent 0 23px, rgba(20,24,32,.04) 23px 24px), ' +
    'linear-gradient(180deg, #dee0e4 0%, #d2d5db 100%)',
  ink: '#141820',
  ink2: 'rgba(20,24,32,0.70)',
  ink3: 'rgba(20,24,32,0.48)',
  ink4: 'rgba(20,24,32,0.28)',
  inkInv: '#f3f4f6',
  line: 'rgba(20,24,32,0.10)',
  lineStrong: 'rgba(20,24,32,0.18)',
  palette,
  shadowLg: '0 1px 0 rgba(20,24,32,.06), 0 28px 64px -16px rgba(20,24,32,.18)',
  shadowMd: '0 1px 0 rgba(20,24,32,.06), 0 12px 32px -8px rgba(20,24,32,.10)',
  shadowSm: '0 1px 0 rgba(20,24,32,.06)',
};

export const darkTheme: Theme = {
  accent: ACCENT,
  bg: '#1a1d23',
  bgApp: '#13161b',
  bgElev: '#252931',
  bgSunken: '#15181d',
  bezel: '#0a0c10',
  bezelInner: '#181b21',
  deviceWall:
    'repeating-linear-gradient(0deg, transparent 0 23px, rgba(255,255,255,.025) 23px 24px), ' +
    'repeating-linear-gradient(90deg, transparent 0 23px, rgba(255,255,255,.025) 23px 24px), ' +
    'linear-gradient(180deg, #1d2027 0%, #15181d 100%)',
  ink: '#ECEEF2',
  ink2: 'rgba(236,238,242,0.70)',
  ink3: 'rgba(236,238,242,0.48)',
  ink4: 'rgba(236,238,242,0.28)',
  inkInv: '#141820',
  line: 'rgba(220,230,245,0.08)',
  lineStrong: 'rgba(220,230,245,0.16)',
  palette,
  shadowLg: '0 2px 4px rgba(0,0,0,.5), 0 32px 64px -16px rgba(0,0,0,.7)',
  shadowMd: '0 1px 0 rgba(0,0,0,.5), 0 12px 32px -8px rgba(0,0,0,.6)',
  shadowSm: '0 1px 0 rgba(0,0,0,.5)',
};

export const themes = { dark: darkTheme, light: lightTheme } as const;
export type ThemeName = keyof typeof themes;
