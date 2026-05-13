// Centraid — themes.
// Each theme is a flat record of presentational values: surfaces, ink,
// lines, shadows, the phone-frame bezel, and the device-wall gradient.
// Both desktop (CSS vars) and mobile (RN StyleSheet) drink from this same
// well — desktop via `toCss()` (see ./css.ts), mobile via direct property
// access (see apps/mobile/src/theme.ts).

import { palette } from './palette';
import type { Palette } from './palette';

// Electric Blue per the Centraid Redesign brief (chat3). Used for the
// FAB, sparkle button, primary CTAs, brand mark, focus rings, and active
// state in version history. Single value across both themes today — if
// we ship a "vivid" or "muted" accent later, lift into a per-theme field.
const ACCENT = '#4950F6';
const ACCENT_LIGHT = '#6B72FF';
const ACCENT_DEEP = '#2D34D9';
const ACCENT_MIDNIGHT = '#1A1F8A';
const ACCENT_VIOLET = '#7C5BD9';

// Semantic tokens — also stable across themes today.
const SUCCESS = '#5C8A4E';
const DANGER = '#C44A4A';

export interface Theme {
  /** Single brand accent — FAB, sparkle, primary CTAs, focus rings. */
  accent: string;
  /** Lighter accent for "new" badges / hovered active rows. */
  accentLight: string;
  /** Darker accent for pressed states / depth. */
  accentDeep: string;
  /** Deepest accent — used sparingly for "midnight" treatments. */
  accentMidnight: string;
  /** Cool-violet sub-accent. Used as the legacy "Centraid purple". */
  accentViolet: string;

  /** Positive state — green check, "live" status pill. */
  success: string;
  /** Negative state — destructive action confirmations, error states. */
  danger: string;

  /**
   * Single "input" lightness for the dark ramp — surfaces below derive
   * from it via `hsl(... calc(var(--bg-l) ± n%))`. Emitted only when set;
   * light theme leaves it undefined (its surfaces are literal hex).
   */
  bgL?: string;

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

  // Sidebar surface — translucent + backdrop-blurred chrome introduced
  // in v0.5. Desktop-only (mobile has no sidebar shell).
  sidebarBg: string;
  sidebarBlur: string;
  sidebarDivider: string;

  /** App-icon palette — same hues across themes by design. */
  palette: Palette;
}

export const lightTheme: Theme = {
  accent: ACCENT,
  accentDeep: ACCENT_DEEP,
  accentLight: ACCENT_LIGHT,
  accentMidnight: ACCENT_MIDNIGHT,
  accentViolet: ACCENT_VIOLET,
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
  sidebarBg: 'rgba(255,255,255,0.65)',
  sidebarBlur: 'blur(28px) saturate(160%)',
  sidebarDivider: '0.5px solid rgba(20,24,32,0.08)',
  success: SUCCESS,
  danger: DANGER,
};

// v0.5: lighter, blue-tinted ramp derived from a single `--bg-l` knob.
// Surfaces use `hsl(... calc(var(--bg-l) ± n%))` so the entire ramp
// retunes by changing one value. Mobile reads only `themes.light`, so
// these `var()` references — which RN cannot resolve — never reach it.
export const darkTheme: Theme = {
  accent: ACCENT,
  accentDeep: ACCENT_DEEP,
  accentLight: ACCENT_LIGHT,
  accentMidnight: ACCENT_MIDNIGHT,
  accentViolet: ACCENT_VIOLET,
  bgL: '18%',
  bg: 'hsl(222 11% var(--bg-l))',
  bgApp: 'hsl(222 12% calc(var(--bg-l) - 5%))',
  bgElev: 'hsl(222 11% calc(var(--bg-l) + 4.5%))',
  bgSunken: 'hsl(222 11% calc(var(--bg-l) - 4%))',
  bezel: '#0a0d13',
  bezelInner: '#14181F',
  deviceWall:
    'repeating-linear-gradient(0deg, transparent 0 23px, rgba(255,255,255,.025) 23px 24px), ' +
    'repeating-linear-gradient(90deg, transparent 0 23px, rgba(255,255,255,.025) 23px 24px), ' +
    'linear-gradient(180deg, hsl(222 13% calc(var(--bg-l) - 2%)) 0%, hsl(222 14% calc(var(--bg-l) - 6%)) 100%)',
  ink: '#ECEEF2',
  ink2: 'rgba(236,238,242,0.72)',
  ink3: 'rgba(236,238,242,0.52)',
  ink4: 'rgba(236,238,242,0.32)',
  inkInv: '#141820',
  line: 'rgba(220,230,245,0.08)',
  lineStrong: 'rgba(220,230,245,0.16)',
  palette,
  shadowLg: '0 2px 4px rgba(0,0,0,.35), 0 32px 64px -16px rgba(0,0,0,.55)',
  shadowMd: '0 1px 0 rgba(0,0,0,.35), 0 12px 32px -8px rgba(0,0,0,.45)',
  shadowSm: '0 1px 0 rgba(0,0,0,.35)',
  sidebarBg: 'hsl(222 11% calc(var(--bg-l) + 2%) / 0.65)',
  sidebarBlur: 'blur(28px) saturate(160%)',
  sidebarDivider: '0.5px solid rgba(255,255,255,0.06)',
  success: SUCCESS,
  danger: DANGER,
};

export const themes = { dark: darkTheme, light: lightTheme } as const;
export type ThemeName = keyof typeof themes;
