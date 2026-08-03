// Centraid's one semantic type scale.
//
// The values below are the product grammar.  Emitters may adapt units (the
// blueprint surface uses rem), but they do not get to invent another scale.
// Native uses the explicit delta on each role so React Native never has to
// parse CSS or perform runtime arithmetic.

export const fonts = {
  mono: "ui-monospace",
  sans: "system-ui",
  serif: "ui-serif",
} as const;

export type FontFamily = keyof typeof fonts;

export const fontStacks = {
  mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  sans: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
} as const satisfies Record<FontFamily, string>;

export interface NativeDelta {
  size: number;
  lineHeight: number;
}

export interface TypeStyle {
  size: number;
  lineHeight: number;
  family: FontFamily;
  weight: "400" | "500" | "600";
  nativeDelta: NativeDelta;
}

export const NATIVE_DELTA_BY_FAMILY = {
  mono: { lineHeight: 2, size: 1 },
  sans: { lineHeight: 2, size: 2 },
  serif: { lineHeight: 2, size: 2 },
} as const satisfies Record<FontFamily, NativeDelta>;

type TypeStyleSource = Omit<TypeStyle, "nativeDelta"> & {
  nativeDelta?: NativeDelta;
};

const style = <T extends TypeStyleSource>(
  value: T
): Omit<T, "nativeDelta"> & { nativeDelta: NativeDelta } => ({
  ...value,
  nativeDelta: NATIVE_DELTA_BY_FAMILY[value.family],
});

export const type = {
  body: style({
    family: "sans",
    lineHeight: 22,
    size: 15,
    weight: "400",
  }),
  bodyStrong: style({
    family: "sans",
    lineHeight: 22,
    size: 15,
    weight: "600",
  }),
  control: style({
    family: "sans",
    lineHeight: 14,
    size: 11,
    weight: "500",
  }),
  display: style({
    family: "sans",
    lineHeight: 34,
    size: 28,
    weight: "600",
  }),
  eyebrow: style({
    family: "mono",
    lineHeight: 13,
    size: 10,
    weight: "600",
  }),
  greeting: style({
    family: "serif",
    lineHeight: 34,
    size: 28,
    weight: "600",
  }),
  hero: style({
    family: "sans",
    lineHeight: 44,
    size: 40,
    weight: "600",
  }),
  mono: style({
    family: "mono",
    lineHeight: 16,
    size: 12,
    weight: "500",
  }),
  small: style({
    family: "sans",
    lineHeight: 18,
    size: 13,
    weight: "400",
  }),
  smallStrong: style({
    family: "sans",
    lineHeight: 18,
    size: 13,
    weight: "600",
  }),
  title: style({
    family: "sans",
    lineHeight: 26,
    size: 20,
    weight: "600",
  }),
} as const;

export type TypeKey = keyof typeof type;

/** The profile-specific support rule is data, not an emitter convention. */
export const TYPE_PROFILE_SUPPORT = {
  shell: [
    "body",
    "bodyStrong",
    "control",
    "display",
    "eyebrow",
    "greeting",
    "hero",
    "mono",
    "small",
    "smallStrong",
    "title",
  ],
  blueprint: [
    "body",
    "bodyStrong",
    "control",
    "display",
    "eyebrow",
    "mono",
    "small",
    "smallStrong",
    "title",
  ],
  native: [
    "body",
    "bodyStrong",
    "control",
    "display",
    "eyebrow",
    "greeting",
    "mono",
    "small",
    "smallStrong",
    "title",
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
) as Record<Exclude<TypeKey, "greeting" | "hero">, BlueprintTypeStyle>;

export function blueprintTypeShorthand(styleValue: BlueprintTypeStyle): string {
  return `${styleValue.weight} ${styleValue.size}/${styleValue.lineHeight} var(--font-${styleValue.family})`;
}

/** camelCase role key → kebab-case custom-property suffix. */
export function typeKeyToKebab(key: string): string {
  return key
    .replace(/(?<lower>[a-z])(?<upper>[A-Z])/gu, "$<lower>-$<upper>")
    .toLowerCase();
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
