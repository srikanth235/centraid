// Nord — frost (#88c0d0) as accent, polar night as bg, snow storm as ink.

import { palette } from '../palette';
import { BEZEL, BEZEL_INNER, type Theme } from './_shared';

export const nordTheme: Theme = {
  kind: 'dark',
  accent: '#88c0d0',
  accentLight: '#a4d2df',
  accentDeep: '#5e9eb3',
  accentMidnight: '#3a6d80',
  accentViolet: '#b48ead',
  bg: '#2e3440',
  bgApp: '#272b35',
  bgElev: '#3b4252',
  bgSunken: '#22262f',
  bgWall: 'linear-gradient(180deg, #353b48 0%, #272b35 100%)',
  bezel: BEZEL,
  bezelInner: BEZEL_INNER,
  deviceWall:
    'repeating-linear-gradient(0deg, transparent 0 23px, rgba(216,222,233,.03) 23px 24px), ' +
    'repeating-linear-gradient(90deg, transparent 0 23px, rgba(216,222,233,.03) 23px 24px), ' +
    'var(--bg-wall)',
  ink: '#eceff4',
  ink2: 'rgba(236,239,244,0.74)',
  ink3: 'rgba(236,239,244,0.54)',
  ink4: 'rgba(236,239,244,0.32)',
  inkInv: '#2e3440',
  line: 'rgba(216,222,233,0.08)',
  lineStrong: 'rgba(216,222,233,0.18)',
  palette,
  shadowLg: '0 2px 4px rgba(0,0,0,.4), 0 32px 64px -16px rgba(0,0,0,.55)',
  shadowMd: '0 1px 0 rgba(0,0,0,.4), 0 12px 32px -8px rgba(0,0,0,.45)',
  shadowSm: '0 1px 0 rgba(0,0,0,.4)',
  sidebarBg: 'linear-gradient(180deg, rgba(59,66,82,0.92) 0%, rgba(46,52,64,0.92) 100%)',
  sidebarBlur: 'blur(28px) saturate(170%)',
  sidebarDivider: '0.5px solid rgba(216,222,233,0.10)',
  success: '#a3be8c',
  danger: '#bf616a',
};
