// Centraid's one semantic type scale — the Binding Layer's second invariant.
//
// ONE RAMP, TWO REGISTERS. Seven sizes, four faces, two weights (400 and 500).
// Every app declares its primary register — reading or scanning — and draws
// every role from this one ramp. Numerics are mono and tabular in every app,
// without exception, which is why `mono` carries `variantNumeric` here rather
// than leaving it to a stylesheet.
//
// The brief's seven roles map onto the repo's role NAMES (no alias layer, and
// no rename of ~400 consumer sites):
//
//   Display  → `display`      31/36 display-serif 400, −.01em
//   Reading  → `reading`      19/33 serif 400              (new)
//   Body     → `body`         15/22 sans 400  (+ `bodyStrong` at 500)
//   UI       → `small`        13/19 sans 400  (+ `smallStrong` at 500)
//   Micro    → `control`      11/15 sans 500  (+ `eyebrow` at 400, caps)
//   Numeric  → `mono`         11.5/16 mono 400, tabular
//   Link     → not a size role: `--link` plus an underline, inheriting.
//
// `title` (20/26 sans 500) is the ONE sanctioned intermediate. It is not in
// the brief; it is kept because ~50 sites need a section heading between the
// 31px display serif and the 15px body, and inventing one per surface is
// exactly the drift the ramp exists to stop.
//
// Nothing falls below 11px. Emitters may adapt units (blueprint uses rem), but
// they do not get to invent another scale. Native uses the explicit delta on
// each role so React Native never parses CSS or does runtime arithmetic.

export const fonts = {
  display: "Instrument Serif",
  mono: "DM Mono",
  sans: "Instrument Sans",
  serif: "Source Serif 4",
} as const;

export type FontFamily = keyof typeof fonts;

// CJK fallbacks are MANDATORY, not defensive. None of the four faces has CJK
// coverage; without an explicit fallback the browser silently substitutes a UA
// default and the product's signature disappears in its largest markets.
export const fontStacks = {
  display:
    "'Instrument Serif', Charter, 'Hiragino Mincho ProN', 'Noto Serif JP', 'Noto Serif SC', 'Songti SC', Georgia, serif",
  mono: "'DM Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "'Instrument Sans', 'Helvetica Neue', 'Hiragino Sans', 'Noto Sans JP', 'Noto Sans SC', 'Microsoft YaHei', system-ui, sans-serif",
  serif:
    "'Source Serif 4', Charter, 'Hiragino Mincho ProN', 'Noto Serif JP', 'Noto Serif SC', 'Songti SC', Georgia, serif",
} as const satisfies Record<FontFamily, string>;

export interface NativeDelta {
  size: number;
  lineHeight: number;
}

export interface TypeStyle {
  size: number;
  lineHeight: number;
  family: FontFamily;
  weight: "400" | "500";
  nativeDelta: NativeDelta;
  /** Tracking, in em. Only the display and micro-caps rungs carry one. */
  letterSpacing?: string;
  /** `text-transform`, for the one role that is always small caps. */
  textTransform?: "uppercase";
  /** `font-variant-numeric`. The numeric register is always tabular. */
  variantNumeric?: "tabular-nums";
}

/**
 * The default per-genus native step. Phone text needs a little more size and
 * leading than a desktop pane at the same role, except where the ramp's own
 * mobile value is smaller — see `NATIVE_DELTA_OVERRIDES`.
 */
export const NATIVE_DELTA_BY_FAMILY = {
  display: { lineHeight: 2, size: 2 },
  mono: { lineHeight: 2, size: 1 },
  sans: { lineHeight: 2, size: 2 },
  serif: { lineHeight: 2, size: 2 },
} as const satisfies Record<FontFamily, NativeDelta>;

/**
 * The two roles the brief gives an explicit mobile size for. A 31px display
 * serif overruns a 390px phone title, and 19px reading prose is one step
 * looser than a phone column wants, so both step DOWN rather than up:
 * display 31 → 27, reading 19 → 17.5.
 */
export const NATIVE_DELTA_OVERRIDES = {
  display: { lineHeight: -4, size: -4 },
  reading: { lineHeight: -2, size: -1.5 },
} as const satisfies Record<string, NativeDelta>;

type TypeStyleSource = Omit<TypeStyle, "nativeDelta">;

const style = <T extends TypeStyleSource>(
  key: string,
  value: T
): T & { nativeDelta: NativeDelta } => ({
  ...value,
  nativeDelta:
    (NATIVE_DELTA_OVERRIDES as Record<string, NativeDelta | undefined>)[key] ??
    NATIVE_DELTA_BY_FAMILY[value.family],
});

// Declared in RAMP order (largest first), not alphabetically: `typeSizeRungs`
// publishes one size rung per distinct size and keeps the first role that owns
// it, so the order below is what decides that `--t-small-size` is the 13px
// rung and `--t-control-size` the 11px one.
export const type = {
  display: style("display", {
    family: "display",
    letterSpacing: "-0.01em",
    lineHeight: 36,
    size: 31,
    weight: "400",
  }),
  title: style("title", {
    family: "sans",
    lineHeight: 26,
    size: 20,
    weight: "500",
  }),
  reading: style("reading", {
    family: "serif",
    lineHeight: 33,
    size: 19,
    weight: "400",
  }),
  body: style("body", {
    family: "sans",
    lineHeight: 22,
    size: 15,
    weight: "400",
  }),
  bodyStrong: style("bodyStrong", {
    family: "sans",
    lineHeight: 22,
    size: 15,
    weight: "500",
  }),
  small: style("small", {
    family: "sans",
    lineHeight: 19,
    size: 13,
    weight: "400",
  }),
  smallStrong: style("smallStrong", {
    family: "sans",
    lineHeight: 19,
    size: 13,
    weight: "500",
  }),
  control: style("control", {
    family: "sans",
    lineHeight: 15,
    size: 11,
    weight: "500",
  }),
  eyebrow: style("eyebrow", {
    family: "sans",
    letterSpacing: "0.06em",
    lineHeight: 15,
    size: 11,
    textTransform: "uppercase",
    weight: "400",
  }),
  mono: style("mono", {
    family: "mono",
    lineHeight: 16,
    size: 11.5,
    variantNumeric: "tabular-nums",
    weight: "400",
  }),
} as const;

export type TypeKey = keyof typeof type;

/** The profile-specific support rule is data, not an emitter convention. The
 *  Binding Layer's ramp is the SAME on all three profiles: a role that only
 *  one surface can render is a role that has stopped being shared. */
export const TYPE_PROFILE_SUPPORT = {
  shell: [
    "display",
    "title",
    "reading",
    "body",
    "bodyStrong",
    "small",
    "smallStrong",
    "control",
    "eyebrow",
    "mono",
  ],
  blueprint: [
    "display",
    "title",
    "reading",
    "body",
    "bodyStrong",
    "small",
    "smallStrong",
    "control",
    "eyebrow",
    "mono",
  ],
  native: [
    "display",
    "title",
    "reading",
    "body",
    "bodyStrong",
    "small",
    "smallStrong",
    "control",
    "eyebrow",
    "mono",
  ],
} as const satisfies Record<string, readonly TypeKey[]>;

export type TypeProfile = keyof typeof TYPE_PROFILE_SUPPORT;

export function typeForProfile(profile: TypeProfile): Partial<typeof type> {
  const supported = new Set<string>(TYPE_PROFILE_SUPPORT[profile]);
  return Object.fromEntries(
    Object.entries(type).filter(([key]) => supported.has(key))
  ) as Partial<typeof type>;
}

export function nativeTypeStyle(styleValue: TypeStyle): TypeStyle {
  return {
    ...styleValue,
    lineHeight: styleValue.lineHeight + styleValue.nativeDelta.lineHeight,
    size: styleValue.size + styleValue.nativeDelta.size,
  };
}

/** CSS `font` shorthand for one semantic style. */
export function typeShorthand(styleValue: TypeStyle): string {
  return `${styleValue.weight} ${styleValue.size}px/${styleValue.lineHeight}px var(--font-${styleValue.family})`;
}

/** Blueprint lowers the same values into host-relative units. */
export interface BlueprintTypeStyle {
  size: `${number}rem`;
  lineHeight: `${number}`;
  family: FontFamily;
  weight: TypeStyle["weight"];
}

function toBlueprintStyle(styleValue: TypeStyle): BlueprintTypeStyle {
  return {
    family: styleValue.family,
    lineHeight: `${styleValue.lineHeight / styleValue.size}`,
    size: `${styleValue.size / 16}rem`,
    weight: styleValue.weight,
  };
}

export const blueprintType = Object.fromEntries(
  Object.entries(typeForProfile("blueprint")).map(([key, value]) => [
    key,
    toBlueprintStyle(value as TypeStyle),
  ])
) as Record<TypeKey, BlueprintTypeStyle>;

export function blueprintTypeShorthand(styleValue: BlueprintTypeStyle): string {
  return `${styleValue.weight} ${styleValue.size}/${styleValue.lineHeight} var(--font-${styleValue.family})`;
}

/** camelCase role key → kebab-case custom-property suffix. */
export function typeKeyToKebab(key: string): string {
  return key
    .replace(/(?<lower>[a-z])(?<upper>[A-Z])/gu, "$<lower>-$<upper>")
    .toLowerCase();
}

/**
 * The properties the CSS `font` shorthand cannot carry.
 *
 * Tracking, small caps and tabular figures are part of a ROLE, not decoration
 * a stylesheet adds on top — "numerics are mono and tabular in every app,
 * without exception" is only true if the tabular figures travel with the role.
 * The shorthand has no slot for any of them, so they are published beside it:
 * a surface writes `font: var(--t-mono); font-variant-numeric:
 * var(--t-mono-numeric);` and cannot get one without the other by accident.
 * Native carries the same three fields on its lowered style.
 */
export function typeModifiers(
  scale: Readonly<Record<string, TypeStyle>>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, styleValue] of Object.entries(scale)) {
    const role = typeKeyToKebab(key);
    if (styleValue.letterSpacing !== undefined) {
      out[`--t-${role}-tracking`] = styleValue.letterSpacing;
    }
    if (styleValue.textTransform !== undefined) {
      out[`--t-${role}-transform`] = styleValue.textTransform;
    }
    if (styleValue.variantNumeric !== undefined) {
      out[`--t-${role}-numeric`] = styleValue.variantNumeric;
    }
  }
  return out;
}

/** Publish one size rung per distinct role size. */
export function typeSizeRungs(
  scale: Record<string, { size: number | `${number}rem` }>
): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, styleValue] of Object.entries(scale)) {
    const value =
      typeof styleValue.size === "number"
        ? `${styleValue.size}px`
        : styleValue.size;
    if (seen.has(value)) continue;
    seen.add(value);
    out[`--t-${typeKeyToKebab(key)}-size`] = value;
  }
  return out;
}
