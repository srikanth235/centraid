// Centraid's one semantic type scale — the Binding Layer's second invariant.
//
// ONE RAMP, ONE FACE. Seven sizes, Instrument Sans, two weights (400 and 600).
// The platform code stack is permitted for code, inline literals and file
// paths only; it is not a type role and ships no bytes. The legacy `mono` ROLE
// name survives because consumers spell it, but it means numeric annotation:
// Instrument Sans with tabular figures, never fixed-advance text.
//
// Pointer roles:
//   Display     → `display`      600 · 32/36 · −.02em
//   Title       → `title`        600 · 20/26 · −.01em
//   Reading     → `reading`      400 · 17/28 · 66ch at the consumer
//   Section     → `smallStrong`  600 · 13/18
//   Body        → `body`/`small` 400 · 13/19
//   Annotation  → `mono`         400 · 11/15 · tabular
//   Micro       → `control` / `eyebrow` 600 · 11/15
//   Held pairs  → `body`/`labelOn` · `annotLabel`/`annotLabelOn` ·
//                 `band`/`control`
//
// Touch is the same rule resolved once: UI text steps up one rung, display
// steps down, and title/reading/micro hold. `bodyStrong` is a 600 · 13/19 rung
// that holds on touch as well — a stable active label under a pointer.
//
// The HELD PAIRS are the other answer to the same problem: a label that bolds
// when it becomes active, where both halves must resolve identically on BOTH
// surfaces so the row cannot re-flow. `body`/`labelOn` is the pair at the body
// rung, `annotLabel`/`annotLabelOn` at the annotation rung, and `band`/
// `control` at the compact navigation band — where `band` is the one UI role
// in the ramp that does not step up on touch at all.
//
// Nothing falls below 11px. Emitters may adapt units (blueprint uses rem), but
// they do not get to invent another scale. Native uses the explicit delta on
// each role so React Native never parses CSS or does runtime arithmetic.

/**
 * The single BUNDLED face this package ships `.woff2` bytes for. A face is no
 * longer something an app can choose.
 */
export const fonts = {
  sans: "Instrument Sans",
} as const;

/** A face with vendored bytes under `../fonts`. */
export type BundledFace = keyof typeof fonts;

/**
 * Every family a stack names.
 *
 * `code` is NOT a face and ships no bytes: it is the PLATFORM code stack,
 * reached only by code surfaces (the fenced-code highlighter, the builder's
 * editor pane, a keyboard chip, a secret or a path shown verbatim). v4s
 * deleted the numeric face, not the ability to set code in a fixed advance —
 * a proportional face turns an aligned diff into a ragged one. Nothing
 * downloads for it, so the ruling's measured win (two fewer font downloads)
 * holds exactly.
 */
export type FontFamily = BundledFace | "code";

// CJK fallbacks are MANDATORY, not defensive. Instrument Sans has no CJK
// coverage; without an explicit fallback the browser silently substitutes a UA
// default and the reading face disappears in the largest markets.
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
  /** Tracking, in em. Only the display and micro-caps rungs carry one. */
  letterSpacing?: string;
  /** `text-transform`, for the one role that is always small caps. */
  textTransform?: "uppercase";
  /** `font-variant-numeric`. The numeric register is always tabular. */
  variantNumeric?: "tabular-nums";
  /** `direction`. Only the numeric role carries one — a number is not a word,
   *  and under RTL the bidi algorithm reorders a mixed digit-and-word run
   *  (`30 July 2026 · 17:42` reads back to front) unless the role pins its own
   *  direction. Declared ONCE, on the role, never per span. */
  direction?: "ltr";
  /** `unicode-bidi`, paired with `direction` so the pinned direction actually
   *  isolates from the surrounding paragraph's own directionality. */
  unicodeBidi?: "isolate";
}

/**
 * The default per-genus native step. Phone text needs a little more size and
 * leading than a desktop pane at the same role, except where the ramp's own
 * mobile value is smaller — see `NATIVE_DELTA_OVERRIDES`.
 */
export const NATIVE_DELTA_BY_FAMILY = {
  code: { lineHeight: 0, size: 0 },
  sans: { lineHeight: 3, size: 2 },
} as const satisfies Record<FontFamily, NativeDelta>;

/**
 * Roles whose touch value does not follow the default +2/+3 UI step. Display
 * steps down to 27/31; title, reading and micro hold their pointer values.
 *
 * `band` holds for a reason that is arithmetic rather than editorial, and it
 * is the only role whose hold is load-bearing: invariant 1 caps the compact
 * band at five destinations plus More, and at 390px those six labels come to
 * 338px inside a 358px band at 11/15. At the annotation rung they come to
 * 386px, which does not fit at any padding. The band is where the ladder's
 * "UI text steps up on touch" rule would break the ladder's own navigation
 * cap, so the exception is declared here rather than worked around in a
 * screen.
 */
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

// Declared in RAMP order (largest first), not alphabetically: `typeSizeRungs`
// publishes one size rung per distinct size and keeps the first role that owns
// it, so the order below is what decides that `--t-small-size` is the 13px
// rung and `--t-control-size` the 11px one.
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
  // A HELD pair is a label that BOLDS when it becomes active: the `-on` half
  // changes the weight and keeps the size and the leading, so a row of chips
  // or a band of tabs cannot re-flow the moment one of them is chosen. The
  // pair only holds if BOTH halves resolve the same way on both surfaces,
  // which is why `bodyStrong` cannot serve as one: it holds at 13/19 on touch
  // while `body` steps to 15/22, so the pair would break exactly where the
  // finger is.
  //
  // Two of the six v9 held roles are already in this ramp and are NOT
  // re-declared here — `label` IS `body` (400 13/19 → 15/22) and `band-on` IS
  // `control` (600 11/15, holding on touch), at both surfaces and with no
  // modifiers between them. DESIGN.md's brief-to-repo table carries the
  // mapping; a duplicate rung would be a second name for one value, which is
  // the thing this file exists to prevent.
  /** The active half of the `body` label pair — 600 at body's own size and
   *  leading, stepping to 15/22 on touch WITH it. */
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
  // The NUMERIC role. Sans since v4s — "numerics are Instrument Sans with
  // tabular figures" — and 11/15 since v7 folded 11.5 onto the 11px rung. It
  // shares that rung with `control`, so `typeSizeRungs` publishes it once, as
  // `--t-control-size`; the `--t-mono` shorthand and its modifiers are still
  // this role's own, because weight, figures and direction are not the size.
  mono: style("mono", {
    direction: "ltr",
    family: "sans",
    lineHeight: 15,
    size: 11,
    unicodeBidi: "isolate",
    variantNumeric: "tabular-nums",
    weight: "400",
  }),
  /**
   * The annotation-rung held pair — a metadata label that bolds when its row
   * becomes active. 11/15 under a pointer, 13/18 on touch.
   *
   * It sits on the same rung as `mono` and is deliberately NOT the same role:
   * `mono` is the NUMERIC register, and it binds tabular figures plus its own
   * `direction: ltr` / `unicode-bidi: isolate`. Those exist so a date-and-time
   * run cannot be reordered under RTL — and they are exactly wrong for a word,
   * which must reorder with the paragraph around it. Same size, different
   * contract.
   */
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
  /** The compact navigation band's label. The one UI role that does NOT step
   *  up on touch — see `NATIVE_DELTA_OVERRIDES` for the measurement that
   *  forces it. Its active half is `control`, which holds on the same rung. */
  band: style("band", {
    family: "sans",
    lineHeight: 15,
    size: 11,
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

/** Resolve the one pointer/touch axis once for an entire lowering. Width is
 * not an input: it may change measure and column count, never type. */
export function typeForSurface(touch: boolean): Record<TypeKey, TypeStyle> {
  return Object.fromEntries(
    Object.entries(type).map(([key, value]) => [
      key,
      touch ? nativeTypeStyle(value) : value,
    ])
  ) as Record<TypeKey, TypeStyle>;
}

// The root a `rem` is relative to. No surface in this repo sets a non-16px
// `html { font-size }` — desktop/web (apps/web/index.html, packages/client)
// and the blueprint iframe both inherit the UA default — so `rem` and `px`
// name the same pixel today. The point of emitting `rem` isn't that they
// differ NOW; it's that only `rem` (or `em`) tracks the OS's 200% text-size
// preference, which changes the ROOT font-size, not individual `px` rules. A
// `px` shorthand is invisible to that preference; a `rem` one scales with it.
export const REM_BASE_PX = 16;

/** CSS `font` shorthand for one semantic style, in host-relative `rem` units
 *  (issue #708 §"Implementation notes for the port" — "Emit `rem`, not `px`,
 *  so 200% OS text scale works"). `toRemStyle` is the single ÷16 conversion
 *  both the shell and the 11px-floor gate reason from. */
export function typeShorthand(styleValue: TypeStyle): string {
  const { size, lineHeight } = toRemStyle(styleValue);
  return `${styleValue.weight} ${size}/${lineHeight} var(--font-${styleValue.family})`;
}

export interface RemTypeStyle {
  size: `${number}rem`;
  lineHeight: `${number}rem`;
}

/** ÷16 against the standard 16px root — see `REM_BASE_PX` above. Shared by
 *  the shell's `typeShorthand` and `typeSizeRungs`'s `--t-<role>-size` rungs,
 *  so the shorthand and its rung never disagree on unit. */
export function toRemStyle(styleValue: {
  size: number;
  lineHeight: number;
}): RemTypeStyle {
  return {
    lineHeight: `${styleValue.lineHeight / REM_BASE_PX}rem`,
    size: `${styleValue.size / REM_BASE_PX}rem`,
  };
}

/** Blueprint lowers the same values into host-relative units. Size matches
 *  the shell's own `rem` conversion (both ÷16); line-height stays a unitless
 *  ratio (÷ the role's OWN size, not the root) — proven independently useful
 *  for a sandboxed app pane that may nest inside a caller-scaled ancestor. */
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

/** camelCase role key → kebab-case custom-property suffix. */
export function typeKeyToKebab(key: string): string {
  return key
    .replace(/(?<lower>[a-z])(?<upper>[A-Z])/gu, "$<lower>-$<upper>")
    .toLowerCase();
}

/**
 * The properties the CSS `font` shorthand cannot carry.
 *
 * Tracking, small caps, tabular figures, and the numeric role's own
 * direction are part of a ROLE, not decoration a stylesheet adds on top —
 * "numerics are mono and tabular in every app, without exception" is only
 * true if the tabular figures travel with the role, and "a number reads in
 * order under RTL" is only true if the direction does too. The shorthand has
 * no slot for any of them, so they are published beside it: a surface writes
 * `font: var(--t-mono); font-variant-numeric: var(--t-mono-numeric);
 * direction: var(--t-mono-direction); unicode-bidi: var(--t-mono-bidi);` and
 * cannot get one without the rest by accident. `--t-mono-direction` /
 * `--t-mono-bidi` belong on TEXT elements only — a layout container that
 * carries the numeric face would flip its own inline axis along with it.
 * Native carries the same fields on its lowered style.
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
    if (styleValue.direction !== undefined) {
      out[`--t-${role}-direction`] = styleValue.direction;
    }
    if (styleValue.unicodeBidi !== undefined) {
      out[`--t-${role}-bidi`] = styleValue.unicodeBidi;
    }
  }
  return out;
}

/** `type`'s raw px sizes, lowered to `rem` — feeds `typeSizeRungs` so the
 *  `--t-<role>-size` rungs carry the same unit as the shorthand's own size
 *  half rather than drifting back to `px` behind the shorthand's back. */
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

/** Publish the composable size of every role. Duplicate values keep their
 * semantic names because pointer/touch can move them onto different rungs. */
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
