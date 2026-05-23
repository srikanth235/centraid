// Solarized — Ethan Schoonover (ethanschoonover.com/solarized).
// Dark variant pivots on base03/base02; light pivots on base3/base2. Blue
// (#268bd2) is the canonical accent; yellow (#b58900) is the warm sub-
// accent we re-use for `accentMidnight` slots.

import { palette } from '../palette';
import { BEZEL, BEZEL_INNER, type Theme } from './_shared';

export const solarizedDarkTheme: Theme = {
  kind: 'dark',
  accent: '#268bd2',
  accentLight: '#3a9fde',
  accentDeep: '#1c6fa8',
  accentMidnight: '#0e3a5a',
  accentViolet: '#6c71c4',
  bg: '#002b36',
  bgApp: '#001f27',
  bgElev: '#073642',
  bgSunken: '#001a21',
  bgWall: 'linear-gradient(180deg, #073642 0%, #001a21 100%)',
  bezel: BEZEL,
  bezelInner: BEZEL_INNER,
  deviceWall:
    'repeating-linear-gradient(0deg, transparent 0 23px, rgba(147,161,161,.04) 23px 24px), ' +
    'repeating-linear-gradient(90deg, transparent 0 23px, rgba(147,161,161,.04) 23px 24px), ' +
    'var(--bg-wall)',
  ink: '#93a1a1',
  ink2: 'rgba(147,161,161,0.78)',
  ink3: 'rgba(147,161,161,0.58)',
  ink4: 'rgba(147,161,161,0.32)',
  inkInv: '#fdf6e3',
  line: 'rgba(147,161,161,0.10)',
  lineStrong: 'rgba(147,161,161,0.20)',
  palette,
  shadowLg: '0 2px 4px rgba(0,0,0,.45), 0 32px 64px -16px rgba(0,0,0,.65)',
  shadowMd: '0 1px 0 rgba(0,0,0,.45), 0 12px 32px -8px rgba(0,0,0,.55)',
  shadowSm: '0 1px 0 rgba(0,0,0,.45)',
  sidebarBg: 'linear-gradient(180deg, rgba(7,54,66,0.92) 0%, rgba(0,43,54,0.92) 100%)',
  sidebarBlur: 'blur(28px) saturate(160%)',
  sidebarDivider: '0.5px solid rgba(147,161,161,0.12)',
  success: '#859900',
  danger: '#dc322f',
};

export const solarizedLightTheme: Theme = {
  kind: 'light',
  accent: '#268bd2',
  accentLight: '#3a9fde',
  accentDeep: '#1c6fa8',
  accentMidnight: '#0e3a5a',
  accentViolet: '#6c71c4',
  bg: '#fdf6e3',
  bgApp: '#fffbf0',
  bgElev: '#fffbf0',
  bgSunken: '#eee8d5',
  bgWall: '#fdf6e3',
  bezel: BEZEL,
  bezelInner: BEZEL_INNER,
  deviceWall:
    'repeating-linear-gradient(0deg, transparent 0 23px, rgba(101,123,131,.05) 23px 24px), ' +
    'repeating-linear-gradient(90deg, transparent 0 23px, rgba(101,123,131,.05) 23px 24px), ' +
    'linear-gradient(180deg, #eee8d5 0%, #e4ddc4 100%)',
  ink: '#073642',
  ink2: 'rgba(7,54,66,0.74)',
  ink3: 'rgba(7,54,66,0.52)',
  ink4: 'rgba(7,54,66,0.30)',
  inkInv: '#fdf6e3',
  line: 'rgba(7,54,66,0.08)',
  lineStrong: 'rgba(7,54,66,0.16)',
  palette,
  shadowLg: '0 1px 2px rgba(7,54,66,.05), 0 24px 48px -16px rgba(7,54,66,.10)',
  shadowMd: '0 1px 2px rgba(7,54,66,.05), 0 8px 24px -8px rgba(7,54,66,.07)',
  shadowSm: '0 1px 2px rgba(7,54,66,.06)',
  sidebarBg: '#eee8d5',
  sidebarBlur: 'none',
  sidebarDivider: '1px solid rgba(7,54,66,0.10)',
  success: '#859900',
  danger: '#dc322f',
};
