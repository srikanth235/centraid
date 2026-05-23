// Airtable — clean white canvas with a cool grey sunken layer (light);
// near-black graphite with a confident interactive blue (dark). Accent
// matches their primary CTA blue (#166ee1).

import { palette } from '../palette';
import { BEZEL, BEZEL_INNER, type Theme } from './_shared';

export const airtableLightTheme: Theme = {
  kind: 'light',
  accent: '#166ee1',
  accentLight: '#3f8ff0',
  accentDeep: '#0d4ea3',
  accentMidnight: '#062f6b',
  accentViolet: '#7c3aed',
  bg: '#ffffff',
  bgApp: '#ffffff',
  bgElev: '#ffffff',
  bgSunken: '#f9fafb',
  bgWall: '#ffffff',
  bezel: BEZEL,
  bezelInner: BEZEL_INNER,
  deviceWall:
    'repeating-linear-gradient(0deg, transparent 0 23px, rgba(29,31,37,.04) 23px 24px), ' +
    'repeating-linear-gradient(90deg, transparent 0 23px, rgba(29,31,37,.04) 23px 24px), ' +
    'linear-gradient(180deg, #e9ebef 0%, #dadde2 100%)',
  ink: '#1d1f25',
  ink2: 'rgba(29,31,37,0.72)',
  ink3: 'rgba(29,31,37,0.50)',
  ink4: 'rgba(29,31,37,0.28)',
  inkInv: '#ffffff',
  line: 'rgba(29,31,37,0.08)',
  lineStrong: 'rgba(29,31,37,0.16)',
  palette,
  shadowLg: '0 1px 2px rgba(29,31,37,.04), 0 24px 48px -16px rgba(29,31,37,.10)',
  shadowMd: '0 1px 2px rgba(29,31,37,.04), 0 8px 24px -8px rgba(29,31,37,.07)',
  shadowSm: '0 1px 2px rgba(29,31,37,.05)',
  sidebarBg: '#f9fafb',
  sidebarBlur: 'none',
  sidebarDivider: '1px solid rgba(29,31,37,0.09)',
  success: '#1f9e63',
  danger: '#df3826',
};

export const airtableDarkTheme: Theme = {
  kind: 'dark',
  accent: '#3f95ff',
  accentLight: '#6dafff',
  accentDeep: '#1f6fd6',
  accentMidnight: '#10437f',
  accentViolet: '#a78bfa',
  bg: '#181a21',
  bgApp: '#121419',
  bgElev: '#23262d',
  bgSunken: '#101218',
  bgWall: 'linear-gradient(180deg, #1f2128 0%, #14161c 100%)',
  bezel: BEZEL,
  bezelInner: BEZEL_INNER,
  deviceWall:
    'repeating-linear-gradient(0deg, transparent 0 23px, rgba(230,232,235,.03) 23px 24px), ' +
    'repeating-linear-gradient(90deg, transparent 0 23px, rgba(230,232,235,.03) 23px 24px), ' +
    'var(--bg-wall)',
  ink: '#e6e8eb',
  ink2: 'rgba(230,232,235,0.72)',
  ink3: 'rgba(230,232,235,0.52)',
  ink4: 'rgba(230,232,235,0.30)',
  inkInv: '#181a21',
  line: 'rgba(230,232,235,0.08)',
  lineStrong: 'rgba(230,232,235,0.18)',
  palette,
  shadowLg: '0 2px 4px rgba(0,0,0,.45), 0 32px 64px -16px rgba(0,0,0,.6)',
  shadowMd: '0 1px 0 rgba(0,0,0,.45), 0 12px 32px -8px rgba(0,0,0,.5)',
  shadowSm: '0 1px 0 rgba(0,0,0,.45)',
  sidebarBg: 'linear-gradient(180deg, rgba(31,33,40,0.92) 0%, rgba(24,26,33,0.92) 100%)',
  sidebarBlur: 'blur(28px) saturate(160%)',
  sidebarDivider: '0.5px solid rgba(230,232,235,0.10)',
  success: '#3ed598',
  danger: '#ff5a4e',
};
