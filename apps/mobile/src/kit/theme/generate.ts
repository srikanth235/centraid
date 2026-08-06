// Deterministic native code generation from @centraid/design's typed lowering.
// There is intentionally no CSS parser or runtime resolver in this module.

import { toNativeTheme } from "@centraid/design";
import type { NativeTheme } from "@centraid/design";

// Direct sub-path exports (see App.tsx's import comment) fix each face's
// weight to its own RN font-family name. The Binding Layer's four faces:
// Instrument Sans (body/UI), Instrument Serif (display), Source Serif 4
// (reading), DM Mono (numeric).
const FONT_ROLES = {
  display: {
    regular: "InstrumentSerif_400Regular",
  },
  mono: {
    medium: "DMMono_500Medium",
    regular: "DMMono_400Regular",
  },
  sans: {
    medium: "InstrumentSans_500Medium",
    regular: "InstrumentSans_400Regular",
  },
  serif: {
    regular: "SourceSerif4_400Regular",
  },
} as const;

export interface GeneratedTheme {
  light: Record<string, string>;
  dark: Record<string, string>;
  radii: Record<string, number>;
  borders: Record<string, number>;
  spacing: Record<string, number>;
  metrics: Record<string, number>;
  pageMargin: NativeTheme["pageMargin"];
  density: NativeTheme["density"];
  fonts: typeof FONT_ROLES;
  type: NativeTheme["type"];
  targetMin: NativeTheme["targetMin"];
  durations: NativeTheme["durations"];
}

function colorRecord(theme: NativeTheme): Record<string, string> {
  return Object.fromEntries(
    Object.entries(theme.colors).map(([key, value]) => [key, value])
  );
}

export function buildTheme(): GeneratedTheme {
  const light = toNativeTheme("light");
  const dark = toNativeTheme("dark");
  return {
    borders: { ...light.borders },
    dark: colorRecord(dark),
    density: light.density,
    durations: light.durations,
    fonts: FONT_ROLES,
    light: colorRecord(light),
    metrics: { ...light.metrics },
    pageMargin: light.pageMargin,
    radii: { ...light.radii },
    spacing: { ...light.spacing },
    targetMin: light.targetMin,
    type: light.type,
  };
}

function sortedEntries<T>(obj: Record<string, T>): [string, T][] {
  return Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function keyLiteral(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : `'${key}'`;
}

function stringLiteral(value: string): string {
  return `'${value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`;
}

function renderRecord(
  obj: Record<string, string | number>,
  indent: string
): string {
  return sortedEntries(obj)
    .map(
      ([key, value]) =>
        `${indent}${keyLiteral(key)}: ${typeof value === "number" ? value : stringLiteral(value)},`
    )
    .join("\n");
}

function renderNested<
  T extends Record<string, Record<string, string | number>>,
>(obj: T, indent: string): string {
  return sortedEntries(obj)
    .map(
      ([key, value]) =>
        `${indent}${key}: {\n${renderRecord(value, `${indent}  `)}\n${indent}},`
    )
    .join("\n");
}

/**
 * `letterSpacing` on the typed lowering is a CSS em string (e.g. `"-0.01em"`)
 * because `packages/design/src/native.ts` is deliberately unit-agnostic — it
 * carries the SAME tracking value shell and blueprint publish as a CSS custom
 * property. React Native's `TextStyle.letterSpacing` has no em unit; it is a
 * plain point number. This is the one native-only conversion: em × the role's
 * own (already phone-adjusted) fontSize, rounded to 2dp so the generated
 * source stays readable.
 */
function emToPoints(em: string, size: number): number {
  const fraction = Number(em.replace(/em$/u, ""));
  return Math.round(fraction * size * 100) / 100;
}

function renderType(type: NativeTheme["type"], indent: string): string {
  return sortedEntries(
    type as Record<string, NativeTheme["type"][keyof NativeTheme["type"]]>
  )
    .map(([key, value]) => {
      const fields = [
        `family: ${stringLiteral(value.family)}`,
        `fontSize: ${value.fontSize}`,
        `lineHeight: ${value.lineHeight}`,
        `weight: ${stringLiteral(value.weight)}`,
      ];
      // Tracking: only the display and micro-caps rungs carry one (§ typography.ts).
      if (value.letterSpacing !== undefined) {
        fields.push(
          `letterSpacing: ${emToPoints(value.letterSpacing, value.fontSize)}`
        );
      }
      // `text-transform: uppercase` on the one role that is always small caps.
      if (value.textTransform !== undefined) {
        fields.push(`textTransform: ${stringLiteral(value.textTransform)}`);
      }
      // RN has no `font-variant-numeric`; the equivalent is the `fontVariant`
      // array prop. "Numerics are mono and tabular in every app, without
      // exception" is only true on native if this travels with the role
      // rather than being left for a consumer to remember.
      if (value.variantNumeric !== undefined) {
        fields.push(`fontVariant: ['${value.variantNumeric}']`);
      }
      return `${indent}${key}: { ${fields.join(", ")} },`;
    })
    .join("\n");
}

export function renderTokensModule(
  theme: GeneratedTheme,
  sourcePath: string
): string {
  return `// GENERATED — do not edit by hand.
// Source: ${sourcePath}
// Regenerate: bun run generate:theme
//
// Native values are lowered from @centraid/design/src/native.ts.  They are
// concrete: no CSS parser, var(), calc(), color-mix(), or runtime overrides.

export const lightPalette = {
${renderRecord(theme.light, "  ")}
} as const;

export const darkPalette = {
${renderRecord(theme.dark, "  ")}
} as const;

export const radii = {
${renderRecord(theme.radii, "  ")}
} as const;

// The one rule weight. A FULL point, never \`StyleSheet.hairlineWidth\` —
// see packages/design/src/borders.ts for why.
export const borders = {
${renderRecord(theme.borders, "  ")}
} as const;

export const spacing = {
${renderRecord(theme.spacing, "  ")}
} as const;

export const metrics = {
${renderRecord(theme.metrics, "  ")}
} as const;

export const density = ${JSON.stringify(theme.density, null, 2)} as const;

export const fonts = {
${renderNested(theme.fonts as unknown as Record<string, Record<string, string>>, "  ")}
} as const;

export const type = {
${renderType(theme.type, "  ")}
} as const;

// The horizontal page inset every screen uses — NOT a \`spacing\` rung.
// See packages/design/src/density.ts#pageMargin for why 18 is off the scale.
export const pageMargin = ${theme.pageMargin};

export const targetMin = ${JSON.stringify(theme.targetMin)} as const;
export const durations = ${JSON.stringify(theme.durations)} as const;
`;
}
