// Typography — font families + a small semantic type scale.
// Two weights only across the chrome (400 + 500/600). No bold. Generous
// line-height in body for AI prose readability.
//
// Primary stacks are system UI fonts only (issue #468 K11). No webfont
// family names (Geist / Space Grotesk) as the first entry — clients that
// still load optional branded faces can layer them locally without
// forcing a network fetch for the chrome.

export const fonts = {
  display: 'system-ui',
  mono: 'ui-monospace',
  sans: 'system-ui',
} as const;

export type FontFamily = keyof typeof fonts;

// Web fallback chains — emitted by `toCss()` as `--font-sans` /
// `--font-display` / `--font-mono`.
export const fontStacks = {
  display:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  sans: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
} as const satisfies Record<FontFamily, string>;

export interface TypeStyle {
  size: number;
  /** px — mobile maps this straight into RN `TextStyle.lineHeight`. */
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

/** Marketing/hero styles — hero sections outside the chrome (onboarding,
 * day-1 home). Web-only (unitless line-heights, and the one place 700
 * appears; the chrome itself keeps to the two-weight rule). Emitted by
 * `toCss()` alongside the canonical scale; mobile does not consume these. */
export interface MarketingTypeStyle {
  size: number;
  /** Unitless CSS line-height multiplier, e.g. `'1.2'`. */
  lineHeight: `${number}`;
  family: FontFamily;
  weight: '400' | '500' | '600' | '700';
}

export const marketingType = {
  'display-1': { family: 'display', lineHeight: '1.1', size: 40, weight: '700' },
  h2: { family: 'display', lineHeight: '1.25', size: 22, weight: '600' },
  h3: { family: 'sans', lineHeight: '1.3', size: 16, weight: '600' },
} as const satisfies Record<string, MarketingTypeStyle>;

export type MarketingTypeKey = keyof typeof marketingType;

/** CSS `font` shorthand for one type style, e.g. `600 20px/26px var(--font-display)`. */
export function typeShorthand(style: TypeStyle | MarketingTypeStyle): string {
  const lh = typeof style.lineHeight === 'number' ? `${style.lineHeight}px` : style.lineHeight;
  return `${style.weight} ${style.size}px/${lh} var(--font-${style.family})`;
}
