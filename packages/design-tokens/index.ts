// Centraid — shared design tokens.
// Platform-agnostic primitives consumed by Electron (apps/desktop) and
// Expo (apps/mobile). Anything platform-specific (CSS variables, RN
// StyleSheet) lives in the consumer; this file only ships values + types.

import { palette } from './palette';
import type { ColorKey, ColorHex } from './palette';
import { icons } from './icons';
import type { IconName, IconPath } from './icons';
import { apps } from './apps';
import type { AppMeta, AppMetaResolved } from './apps';

const colors = {
  // Light theme — matches the Electron renderer's [data-theme="light"]
  accent: '#4950F6',
  bg: '#e8e9ec',
  bgApp: '#fafbfc',
  bgElev: '#f3f4f6',
  bgSunken: '#dcdee2',
  ink: '#141820',
  ink2: 'rgba(20,24,32,0.70)',
  ink3: 'rgba(20,24,32,0.48)',
  ink4: 'rgba(20,24,32,0.28)',
  inkInv: '#f3f4f6',
  line: 'rgba(20,24,32,0.10)',
  lineStrong: 'rgba(20,24,32,0.18)',
  palette,
} as const;

// Hard-edged radii — Centraid is an instrument, not a pillow.
const radii = { lg: 10, md: 6, sm: 4, xl: 14, xs: 2 } as const;

// Spacing scale (matches the renderer's --d-* tokens)
const spacing = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48 } as const;

// Font *names* only — consumers load them their own way.
const fonts = {
  display: 'Space Grotesk',
  mono: 'JetBrains Mono',
  sans: 'Geist',
} as const;

type FontFamily = keyof typeof fonts;

interface TypeStyle {
  size: number;
  lineHeight: number;
  family: FontFamily;
  weight: '400' | '500' | '600';
}

const type = {
  body: { family: 'sans', lineHeight: 22, size: 15, weight: '400' },
  bodyStrong: { family: 'sans', lineHeight: 22, size: 15, weight: '600' },
  display: { family: 'display', lineHeight: 34, size: 28, weight: '600' },
  mono: { family: 'mono', lineHeight: 16, size: 12, weight: '500' },
  small: { family: 'sans', lineHeight: 18, size: 13, weight: '400' },
  tiny: { family: 'sans', lineHeight: 14, size: 11, weight: '500' },
  title: { family: 'display', lineHeight: 26, size: 20, weight: '600' },
} as const satisfies Record<string, TypeStyle>;

type TypeKey = keyof typeof type;

export { palette, colors, radii, spacing, fonts, type, icons, apps };
export type {
  ColorKey,
  ColorHex,
  IconName,
  IconPath,
  AppMeta,
  AppMetaResolved,
  FontFamily,
  TypeKey,
  TypeStyle,
};
