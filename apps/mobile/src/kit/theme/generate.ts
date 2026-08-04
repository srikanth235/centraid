// Deterministic native code generation from @centraid/design's typed lowering.
// There is intentionally no CSS parser or runtime resolver in this module.

import { ACCENT_PALETTE, toNativeTheme } from "@centraid/design";
import type { AccentKey, NativeTheme } from "@centraid/design";

const FONT_ROLES = {
  mono: {
    medium: "JetBrainsMono_500Medium",
    regular: "JetBrainsMono_400Regular",
    semibold: "JetBrainsMono_600SemiBold",
  },
  sans: {
    medium: "Geist_500Medium",
    regular: "Geist_400Regular",
    semibold: "Geist_600SemiBold",
  },
  serif: {
    semibold: "PlayfairDisplay_600SemiBold",
    semiboldItalic: "PlayfairDisplay_600SemiBold_Italic",
  },
} as const;

export interface GeneratedTheme {
  accentThemes: Record<
    AccentKey,
    { light: Record<string, string>; dark: Record<string, string> }
  >;
  light: Record<string, string>;
  dark: Record<string, string>;
  radii: Record<string, number>;
  spacing: Record<string, number>;
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
  const accentThemes = Object.fromEntries(
    Object.keys(ACCENT_PALETTE).map((accentKey) => [
      accentKey,
      {
        dark: colorRecord(toNativeTheme("dark", accentKey as AccentKey)),
        light: colorRecord(toNativeTheme("light", accentKey as AccentKey)),
      },
    ])
  ) as GeneratedTheme["accentThemes"];
  return {
    accentThemes,
    dark: colorRecord(dark),
    durations: light.durations,
    fonts: FONT_ROLES,
    light: colorRecord(light),
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

function renderType(type: NativeTheme["type"], indent: string): string {
  return sortedEntries(
    type as Record<string, NativeTheme["type"][keyof NativeTheme["type"]]>
  )
    .map(
      ([key, value]) =>
        `${indent}${key}: { family: ${stringLiteral(value.family)}, fontSize: ${value.fontSize}, lineHeight: ${value.lineHeight}, weight: ${stringLiteral(value.weight)} },`
    )
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

export const accentThemes = ${JSON.stringify(theme.accentThemes, null, 2)} as const;

export const radii = {
${renderRecord(theme.radii, "  ")}
} as const;

export const spacing = {
${renderRecord(theme.spacing, "  ")}
} as const;

export const fonts = {
${renderNested(theme.fonts as unknown as Record<string, Record<string, string>>, "  ")}
} as const;

export const type = {
${renderType(theme.type, "  ")}
} as const;

export const targetMin = ${JSON.stringify(theme.targetMin)} as const;
export const durations = ${JSON.stringify(theme.durations)} as const;
`;
}
