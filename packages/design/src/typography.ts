// The one semantic type scale (Binding Layer invariant 2). ONE RAMP, ONE FACE;
// the `mono` ROLE means NUMERIC ANNOTATION, never fixed advance. Touch resolves
// once, and a HELD PAIR must resolve identically on BOTH surfaces or its row
// re-flows. Nothing falls below 11px.

export const fonts = {
  sans: "Instrument Sans",
} as const;

export type BundledFace = keyof typeof fonts;

export type FontFamily = BundledFace | "code";

// CJK fallbacks are MANDATORY: Instrument Sans has no CJK coverage, and the
// browser substitutes a UA default silently.
export const fontStacks = {
  code: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  sans: "'Instrument Sans', 'Helvetica Neue', 'Hiragino Sans', 'Noto Sans JP', 'Noto Sans SC', 'Microsoft YaHei', system-ui, sans-serif",
} as const satisfies Record<FontFamily, string>;

export interface NativeDelta {
  size: number;
  lineHeight: number;
}

export interface TypeStyle {
  size: number;
  lineHeight: number;
  family: FontFamily;
  weight: "400" | "600";
  nativeDelta: NativeDelta;
  letterSpacing?: string;
  textTransform?: "uppercase";
  variantNumeric?: "tabular-nums";
  /** Only the NUMERIC role pins one: RTL bidi reorders a mixed run otherwise. */
  direction?: "ltr";
  unicodeBidi?: "isolate";
}

export const NATIVE_DELTA_BY_FAMILY = {
  code: { lineHeight: 0, size: 0 },
  sans: { lineHeight: 3, size: 2 },
} as const satisfies Record<FontFamily, NativeDelta>;

/** `band`'s hold is ARITHMETIC: six labels are 338px inside a 358px band at
 *  11/15, and 386px one rung up — which fits at no padding. */
export const NATIVE_DELTA_OVERRIDES = {
  band: { lineHeight: 0, size: 0 },
  bodyStrong: { lineHeight: 0, size: 0 },
  control: { lineHeight: 0, size: 0 },
  display: { lineHeight: -5, size: -5 },
  eyebrow: { lineHeight: 0, size: 0 },
  reading: { lineHeight: 0, size: 0 },
  title: { lineHeight: 0, size: 0 },
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

export const type = {
  display: style("display", {
    family: "sans",
    letterSpacing: "-0.02em",
    lineHeight: 36,
    size: 32,
    weight: "600",
  }),
  title: style("title", {
    family: "sans",
    letterSpacing: "-0.01em",
    lineHeight: 26,
    size: 20,
    weight: "600",
  }),
  reading: style("reading", {
    family: "sans",
    lineHeight: 28,
    size: 17,
    weight: "400",
  }),
  body: style("body", {
    family: "sans",
    lineHeight: 19,
    size: 13,
    weight: "400",
  }),
  bodyStrong: style("bodyStrong", {
    family: "sans",
    lineHeight: 19,
    size: 13,
    weight: "600",
  }),
  // ── The held pairs ──────────────────────────────────────────────────────
  //
  // `bodyStrong` cannot be a held half: it holds at 13/19 on touch while `body`
  // steps to 15/22. `label` IS `body`, `band-on` IS `control`.
  labelOn: style("labelOn", {
    family: "sans",
    lineHeight: 19,
    size: 13,
    weight: "600",
  }),
  small: style("small", {
    family: "sans",
    lineHeight: 19,
    size: 13,
    weight: "400",
  }),
  smallStrong: style("smallStrong", {
    family: "sans",
    lineHeight: 18,
    size: 13,
    weight: "600",
  }),
  control: style("control", {
    family: "sans",
    lineHeight: 15,
    size: 11,
    weight: "600",
  }),
  eyebrow: style("eyebrow", {
    family: "sans",
    letterSpacing: "0.06em",
    lineHeight: 15,
    size: 11,
    textTransform: "uppercase",
    weight: "600",
  }),
  mono: style("mono", {
    direction: "ltr",
    family: "sans",
    lineHeight: 15,
    size: 11,
    unicodeBidi: "isolate",
    variantNumeric: "tabular-nums",
    weight: "400",
  }),
  annotLabel: style("annotLabel", {
    family: "sans",
    lineHeight: 15,
    size: 11,
    weight: "400",
  }),
  annotLabelOn: style("annotLabelOn", {
    family: "sans",
    lineHeight: 15,
    size: 11,
    weight: "600",
  }),
  band: style("band", {
    family: "sans",
    lineHeight: 15,
    size: 11,
    weight: "400",
  }),
} as const;

export type TypeKey = keyof typeof type;

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
    "labelOn",
    "annotLabel",
    "annotLabelOn",
    "band",
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
    "labelOn",
    "annotLabel",
    "annotLabelOn",
    "band",
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
    "labelOn",
    "annotLabel",
    "annotLabelOn",
    "band",
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

export function typeForSurface(touch: boolean): Record<TypeKey, TypeStyle> {
  return Object.fromEntries(
    Object.entries(type).map(([key, value]) => [
      key,
      touch ? nativeTypeStyle(value) : value,
    ])
  ) as Record<TypeKey, TypeStyle>;
}

// `rem`, not `px`: only `rem` tracks the OS's 200% text-size preference, which
// moves the ROOT font-size and never individual `px` rules.
export const REM_BASE_PX = 16;

export function typeShorthand(styleValue: TypeStyle): string {
  const { size, lineHeight } = toRemStyle(styleValue);
  return `${styleValue.weight} ${size}/${lineHeight} var(--font-${styleValue.family})`;
}

export interface RemTypeStyle {
  size: `${number}rem`;
  lineHeight: `${number}rem`;
}

export function toRemStyle(styleValue: {
  size: number;
  lineHeight: number;
}): RemTypeStyle {
  return {
    lineHeight: `${styleValue.lineHeight / REM_BASE_PX}rem`,
    size: `${styleValue.size / REM_BASE_PX}rem`,
  };
}

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
    size: `${styleValue.size / REM_BASE_PX}rem`,
    weight: styleValue.weight,
  };
}

export const blueprintType = Object.fromEntries(
  Object.entries(typeForProfile("blueprint")).map(([key, value]) => [
    key,
    toBlueprintStyle(value as TypeStyle),
  ])
) as Record<TypeKey, BlueprintTypeStyle>;

export function blueprintTypeForSurface(
  touch: boolean
): Record<TypeKey, BlueprintTypeStyle> {
  return Object.fromEntries(
    Object.entries(typeForSurface(touch)).map(([key, value]) => [
      key,
      toBlueprintStyle(value),
    ])
  ) as Record<TypeKey, BlueprintTypeStyle>;
}

export function blueprintTypeShorthand(styleValue: BlueprintTypeStyle): string {
  return `${styleValue.weight} ${styleValue.size}/${styleValue.lineHeight} var(--font-${styleValue.family})`;
}

export function typeKeyToKebab(key: string): string {
  return key
    .replace(/(?<lower>[a-z])(?<upper>[A-Z])/gu, "$<lower>-$<upper>")
    .toLowerCase();
}

/** Published beside the shorthand, which cannot carry them, so a surface takes
 *  none without the rest. `--t-mono-direction`/`-bidi` belong on TEXT elements
 *  only: a container carrying them flips its own inline axis. */
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
    if (styleValue.direction !== undefined) {
      out[`--t-${role}-direction`] = styleValue.direction;
    }
    if (styleValue.unicodeBidi !== undefined) {
      out[`--t-${role}-bidi`] = styleValue.unicodeBidi;
    }
  }
  return out;
}

export function remSizeScale(
  scale: Readonly<Record<string, { size: number }>>
): Record<string, { size: `${number}rem` }> {
  return Object.fromEntries(
    Object.entries(scale).map(([key, value]) => [
      key,
      { size: toRemStyle({ lineHeight: 0, size: value.size }).size },
    ])
  );
}

export function typeSizeRungs(
  scale: Record<string, { size: number | `${number}rem` }>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, styleValue] of Object.entries(scale)) {
    const value =
      typeof styleValue.size === "number"
        ? `${styleValue.size}px`
        : styleValue.size;
    out[`--t-${typeKeyToKebab(key)}-size`] = value;
  }
  return out;
}
