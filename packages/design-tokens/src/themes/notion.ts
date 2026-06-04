// Notion — warm near-white surfaces with a beige sidebar (light); deep
// graphite with a slight warm tint (dark). Notion's blue (#2383e2) is
// the canonical link / accent.

import { palette } from '../palette';
import { BEZEL, BEZEL_INNER, type Theme } from './shared';

export const notionLightTheme: Theme = {
  kind: 'light',
  accent: '#2383e2',
  accentLight: '#4ea4ee',
  accentDeep: '#1565b3',
  accentMidnight: '#0e4a85',
  accentViolet: '#9065b0',
  bg: '#ffffff',
  bgApp: '#ffffff',
  bgElev: '#ffffff',
  bgSunken: '#f7f6f3',
  bgWall: '#ffffff',
  bezel: BEZEL,
  bezelInner: BEZEL_INNER,
  deviceWall:
    'repeating-linear-gradient(0deg, transparent 0 23px, rgba(55,53,47,.04) 23px 24px), ' +
    'repeating-linear-gradient(90deg, transparent 0 23px, rgba(55,53,47,.04) 23px 24px), ' +
    'linear-gradient(180deg, #ebeae5 0%, #dedcd6 100%)',
  ink: '#37352f',
  ink2: 'rgba(55,53,47,0.72)',
  ink3: 'rgba(55,53,47,0.50)',
  ink4: 'rgba(55,53,47,0.28)',
  inkInv: '#ffffff',
  line: 'rgba(55,53,47,0.09)',
  lineStrong: 'rgba(55,53,47,0.16)',
  palette,
  shadowLg: '0 1px 2px rgba(55,53,47,.06), 0 24px 48px -16px rgba(55,53,47,.12)',
  shadowMd: '0 1px 2px rgba(55,53,47,.05), 0 8px 24px -8px rgba(55,53,47,.08)',
  shadowSm: '0 1px 2px rgba(55,53,47,.06)',
  sidebarBg: '#f7f6f3',
  sidebarBlur: 'none',
  sidebarDivider: '1px solid rgba(55,53,47,0.09)',
  success: '#0f7b6c',
  danger: '#e03e3e',
};

export const notionDarkTheme: Theme = {
  kind: 'dark',
  accent: '#529cca',
  accentLight: '#7eb6d6',
  accentDeep: '#3878a3',
  accentMidnight: '#1f4a6b',
  accentViolet: '#9a6dd7',
  bg: '#191919',
  bgApp: '#141414',
  bgElev: '#2f2f2f',
  bgSunken: '#121212',
  bgWall: 'linear-gradient(180deg, #1f1f1f 0%, #141414 100%)',
  bezel: BEZEL,
  bezelInner: BEZEL_INNER,
  deviceWall:
    'repeating-linear-gradient(0deg, transparent 0 23px, rgba(255,255,255,.03) 23px 24px), ' +
    'repeating-linear-gradient(90deg, transparent 0 23px, rgba(255,255,255,.03) 23px 24px), ' +
    'var(--bg-wall)',
  ink: 'rgba(255,255,255,0.81)',
  ink2: 'rgba(255,255,255,0.60)',
  ink3: 'rgba(255,255,255,0.45)',
  ink4: 'rgba(255,255,255,0.28)',
  inkInv: '#191919',
  line: 'rgba(255,255,255,0.094)',
  lineStrong: 'rgba(255,255,255,0.16)',
  palette,
  shadowLg: '0 2px 4px rgba(0,0,0,.4), 0 32px 64px -16px rgba(0,0,0,.55)',
  shadowMd: '0 1px 0 rgba(0,0,0,.4), 0 12px 32px -8px rgba(0,0,0,.45)',
  shadowSm: '0 1px 0 rgba(0,0,0,.4)',
  sidebarBg: 'linear-gradient(180deg, rgba(32,32,32,0.92) 0%, rgba(25,25,25,0.92) 100%)',
  sidebarBlur: 'blur(28px) saturate(160%)',
  sidebarDivider: '0.5px solid rgba(255,255,255,0.094)',
  success: '#4dab9a',
  danger: '#ff7369',
};
