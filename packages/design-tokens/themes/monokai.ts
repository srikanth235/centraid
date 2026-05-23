// Monokai — the classic editor theme. Pink (#f92672) is the canonical
// accent; yellow-green (#a6e22e) is the success/string color.

import { palette } from '../palette';
import { BEZEL, BEZEL_INNER, type Theme } from './_shared';

export const monokaiTheme: Theme = {
  kind: 'dark',
  accent: '#f92672',
  accentLight: '#fb558e',
  accentDeep: '#c41058',
  accentMidnight: '#7a0a37',
  accentViolet: '#ae81ff',
  bg: '#272822',
  bgApp: '#1e1f1c',
  bgElev: '#34352d',
  bgSunken: '#1a1b16',
  bgWall: 'linear-gradient(180deg, #2d2e26 0%, #1e1f1a 100%)',
  bezel: BEZEL,
  bezelInner: BEZEL_INNER,
  deviceWall:
    'repeating-linear-gradient(0deg, transparent 0 23px, rgba(248,248,242,.03) 23px 24px), ' +
    'repeating-linear-gradient(90deg, transparent 0 23px, rgba(248,248,242,.03) 23px 24px), ' +
    'var(--bg-wall)',
  ink: '#f8f8f2',
  ink2: 'rgba(248,248,242,0.72)',
  ink3: 'rgba(248,248,242,0.52)',
  ink4: 'rgba(248,248,242,0.30)',
  inkInv: '#272822',
  line: 'rgba(248,248,242,0.08)',
  lineStrong: 'rgba(248,248,242,0.18)',
  palette,
  shadowLg: '0 2px 4px rgba(0,0,0,.45), 0 32px 64px -16px rgba(0,0,0,.6)',
  shadowMd: '0 1px 0 rgba(0,0,0,.45), 0 12px 32px -8px rgba(0,0,0,.5)',
  shadowSm: '0 1px 0 rgba(0,0,0,.45)',
  sidebarBg: 'linear-gradient(180deg, rgba(52,53,45,0.92) 0%, rgba(39,40,34,0.92) 100%)',
  sidebarBlur: 'blur(28px) saturate(160%)',
  sidebarDivider: '0.5px solid rgba(248,248,242,0.10)',
  success: '#a6e22e',
  danger: '#f92672',
};
