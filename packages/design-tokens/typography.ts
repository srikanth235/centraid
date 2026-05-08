// Typography — font families + a small semantic type scale.
// Two weights only across the chrome (400 + 500/600). No bold. Generous
// line-height in body for AI prose readability.

export const fonts = {
  display: 'Space Grotesk',
  mono: 'JetBrains Mono',
  sans: 'Geist',
} as const;

export type FontFamily = keyof typeof fonts;

export interface TypeStyle {
  size: number;
  lineHeight: number;
  family: FontFamily;
  weight: '400' | '500' | '600';
}

export const type = {
  body: { family: 'sans', lineHeight: 22, size: 15, weight: '400' },
  bodyStrong: { family: 'sans', lineHeight: 22, size: 15, weight: '600' },
  display: { family: 'display', lineHeight: 34, size: 28, weight: '600' },
  mono: { family: 'mono', lineHeight: 16, size: 12, weight: '500' },
  small: { family: 'sans', lineHeight: 18, size: 13, weight: '400' },
  tiny: { family: 'sans', lineHeight: 14, size: 11, weight: '500' },
  title: { family: 'display', lineHeight: 26, size: 20, weight: '600' },
} as const satisfies Record<string, TypeStyle>;

export type TypeKey = keyof typeof type;
