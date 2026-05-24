// GitHub — Primer palette. Accent is the canonical link blue.

import { palette } from '../palette';
import { BEZEL, BEZEL_INNER, type Theme } from './_shared';

export const githubLightTheme: Theme = {
  kind: 'light',
  accent: '#0969da',
  accentLight: '#218bff',
  accentDeep: '#0550ae',
  accentMidnight: '#033d8b',
  accentViolet: '#8250df',
  bg: '#ffffff',
  bgApp: '#ffffff',
  bgElev: '#ffffff',
  bgSunken: '#f6f8fa',
  bgWall: '#ffffff',
  bezel: BEZEL,
  bezelInner: BEZEL_INNER,
  deviceWall:
    'repeating-linear-gradient(0deg, transparent 0 23px, rgba(31,35,40,.04) 23px 24px), ' +
    'repeating-linear-gradient(90deg, transparent 0 23px, rgba(31,35,40,.04) 23px 24px), ' +
    'linear-gradient(180deg, #eaeef2 0%, #d8dee4 100%)',
  ink: '#1f2328',
  ink2: 'rgba(31,35,40,0.72)',
  ink3: 'rgba(31,35,40,0.50)',
  ink4: 'rgba(31,35,40,0.28)',
  inkInv: '#ffffff',
  line: 'rgba(31,35,40,0.08)',
  lineStrong: 'rgba(31,35,40,0.16)',
  palette,
  shadowLg: '0 1px 2px rgba(31,35,40,.04), 0 24px 48px -16px rgba(31,35,40,.10)',
  shadowMd: '0 1px 2px rgba(31,35,40,.04), 0 8px 24px -8px rgba(31,35,40,.06)',
  shadowSm: '0 1px 2px rgba(31,35,40,.05)',
  sidebarBg: '#f6f8fa',
  sidebarBlur: 'none',
  sidebarDivider: '1px solid rgba(208,215,222,1)',
  success: '#1a7f37',
  danger: '#cf222e',
};

export const githubDarkTheme: Theme = {
  kind: 'dark',
  accent: '#58a6ff',
  accentLight: '#79b8ff',
  accentDeep: '#388bfd',
  accentMidnight: '#1f6feb',
  accentViolet: '#a371f7',
  bg: '#0d1117',
  bgApp: '#010409',
  bgElev: '#161b22',
  bgSunken: '#010409',
  bgWall: 'linear-gradient(180deg, #161b22 0%, #0d1117 100%)',
  bezel: BEZEL,
  bezelInner: BEZEL_INNER,
  deviceWall:
    'repeating-linear-gradient(0deg, transparent 0 23px, rgba(201,209,217,.03) 23px 24px), ' +
    'repeating-linear-gradient(90deg, transparent 0 23px, rgba(201,209,217,.03) 23px 24px), ' +
    'var(--bg-wall)',
  ink: '#e6edf3',
  ink2: 'rgba(230,237,243,0.72)',
  ink3: 'rgba(230,237,243,0.52)',
  ink4: 'rgba(230,237,243,0.32)',
  inkInv: '#0d1117',
  line: 'rgba(48,54,61,1)',
  lineStrong: 'rgba(80,92,104,1)',
  palette,
  shadowLg: '0 2px 4px rgba(0,0,0,.5), 0 32px 64px -16px rgba(0,0,0,.7)',
  shadowMd: '0 1px 0 rgba(0,0,0,.5), 0 12px 32px -8px rgba(0,0,0,.55)',
  shadowSm: '0 1px 0 rgba(0,0,0,.5)',
  sidebarBg: 'linear-gradient(180deg, rgba(22,27,34,0.92) 0%, rgba(13,17,23,0.92) 100%)',
  sidebarBlur: 'blur(28px) saturate(160%)',
  sidebarDivider: '0.5px solid rgba(48,54,61,1)',
  success: '#3fb950',
  danger: '#f85149',
};
