// Typography — font families + a small semantic type scale.
// Two weights only across the chrome (400 + 500/600). No bold. Generous
// line-height in body for AI prose readability.
//
// Primary stacks are system UI fonts only (issue #468 K11). No webfont
// family names (Geist / Space Grotesk) as the first entry — clients that
// still load optional branded faces can layer them locally without
// forcing a network fetch for the chrome.

export const fonts = {
  display: "system-ui",
  mono: "ui-monospace",
  sans: "system-ui",
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
  weight: "400" | "500" | "600";
}

export const type = {
  body: { family: "sans", lineHeight: 22, size: 15, weight: "400" },
  bodyStrong: { family: "sans", lineHeight: 22, size: 15, weight: "600" },
  display: { family: "display", lineHeight: 34, size: 28, weight: "600" },
  mono: { family: "mono", lineHeight: 16, size: 12, weight: "500" },
  small: { family: "sans", lineHeight: 18, size: 13, weight: "400" },
  tiny: { family: "sans", lineHeight: 14, size: 11, weight: "500" },
  title: { family: "display", lineHeight: 26, size: 20, weight: "600" },
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
  weight: "400" | "500" | "600" | "700";
}

export const marketingType = {
  "display-1": {
    family: "display",
    lineHeight: "1.1",
    size: 40,
    weight: "700",
  },
  h2: { family: "display", lineHeight: "1.25", size: 22, weight: "600" },
  h3: { family: "sans", lineHeight: "1.3", size: 16, weight: "600" },
} as const satisfies Record<string, MarketingTypeStyle>;

export type MarketingTypeKey = keyof typeof marketingType;

/** CSS `font` shorthand for one type style, e.g. `600 20px/26px var(--font-display)`. */
export function typeShorthand(style: TypeStyle | MarketingTypeStyle): string {
  const lh =
    typeof style.lineHeight === "number"
      ? `${style.lineHeight}px`
      : style.lineHeight;
  return `${style.weight} ${style.size}px/${lh} var(--font-${style.family})`;
}

/**
 * Blueprint-surface type scale (#686). The blueprint layer has its OWN scale —
 * rem-based sizes and unitless line-heights, so an app that is embedded at a
 * different root size scales with its host — and it is deliberately NOT the
 * shell's: `--t-small` is 13px in the chrome and 0.8rem here. Both surfaces are
 * type, so both tables live in this module; `blueprint.ts` used to carry these
 * six values as opaque shorthand strings, which meant nothing could read a size
 * off them.
 *
 * `family` is the full custom-property name rather than a `FontFamily` role
 * key, because the blueprint layer publishes `--mono` (not `--font-mono`) and
 * adds `--font-title`; see `lightProps()` in blueprint.ts.
 */
export interface BlueprintTypeStyle {
  size: `${number}rem`;
  /** Unitless CSS line-height multiplier, e.g. `'1.5'`. */
  lineHeight: `${number}`;
  family: "font-sans" | "font-title" | "mono";
  weight: "400" | "500" | "600";
}

export const blueprintType = {
  body: {
    family: "font-sans",
    lineHeight: "1.5",
    size: "0.855rem",
    weight: "400",
  },
  bodyStrong: {
    family: "font-sans",
    lineHeight: "1.4",
    size: "0.855rem",
    weight: "600",
  },
  mono: { family: "mono", lineHeight: "1.4", size: "0.72rem", weight: "500" },
  small: {
    family: "font-sans",
    lineHeight: "1.45",
    size: "0.8rem",
    weight: "400",
  },
  tiny: { family: "mono", lineHeight: "1.4", size: "0.6rem", weight: "600" },
  title: {
    family: "font-title",
    lineHeight: "1.2",
    size: "1.15rem",
    weight: "600",
  },
} as const satisfies Record<string, BlueprintTypeStyle>;

/** CSS `font` shorthand for one blueprint style, e.g. `600 1.15rem/1.2 var(--font-title)`. */
export function blueprintTypeShorthand(style: BlueprintTypeStyle): string {
  return `${style.weight} ${style.size}/${style.lineHeight} var(--${style.family})`;
}

/** camelCase type key → the kebab-case half of its custom-property name. */
export function typeKeyToKebab(key: string): string {
  return key
    .replace(/(?<lower>[a-z])(?<upper>[A-Z])/gu, "$<lower>-$<upper>")
    .toLowerCase();
}

/**
 * The composable SIZE rungs (#686).
 *
 * `--t-*` are CSS `font` **shorthands**: using one sets family, weight, size
 * and line-height together, all or nothing. A rule that wants the scale's size
 * but a different weight — or that must inherit the family from its host — had
 * no token to reach for and wrote a raw `font-size`. `--t-<key>-size` is that
 * missing rung, and nothing else: it carries the size and no other facet.
 *
 * The suffix spelling follows `--c-<hue>-text`, the other facet-of-a-token in
 * this vocabulary, and keeps a rung sorted next to the shorthand it belongs to.
 *
 * ONE property per distinct size, first key wins: `body` and `bodyStrong` are
 * both 15px, so the pair publishes `--t-body-size` only. A duplicate property
 * would be two spellings for one value, which is exactly what the contract in
 * `contract.ts` exists to forbid.
 */
export function typeSizeRungs(
  scale: Record<string, { size: number | `${number}rem` }>
): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, style] of Object.entries(scale)) {
    const value =
      typeof style.size === "number" ? `${style.size}px` : style.size;
    if (seen.has(value)) continue;
    seen.add(value);
    out[`--t-${typeKeyToKebab(key)}-size`] = value;
  }
  return out;
}
