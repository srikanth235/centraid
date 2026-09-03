import type { TextStyle } from "react-native";

import { toNativeTheme } from "@centraid/design/native";
import type {
  NativeScheme,
  NativeTheme,
  NativeTypeStyle,
} from "@centraid/design/native";

export const family = {
  monoMedium: "monospace",
  monoRegular: "monospace",
  sansMedium: "InstrumentSans_600SemiBold",
  sansRegular: "InstrumentSans_470Book",
} as const;

export const fonts = {
  sans: {
    regular: family.sansRegular,
    semibold: family.sansMedium,
  },
} as const;

type FamilyKey = NativeTypeStyle["family"];

const FAMILY_BY_WEIGHT: Record<FamilyKey, Record<string, string>> = {
  sans: {
    "400": family.sansRegular,
    "600": family.sansMedium,
  },
};

export const popoverShadow = {
  elevation: 8,
  shadowColor: "#141414",
  shadowOffset: { height: 8, width: 0 },
  shadowOpacity: 0.1,
  shadowRadius: 10,
} as const;

export type NativeTextRole = Pick<
  TextStyle,
  | "fontSize"
  | "lineHeight"
  | "fontFamily"
  | "letterSpacing"
  | "textTransform"
  | "fontVariant"
>;

const canonicalThemes: Record<NativeScheme, NativeTheme> = {
  dark: toNativeTheme("dark"),
  light: toNativeTheme("light"),
};

function emToPoints(value: string, size: number): number {
  return Math.round(Number(value.replace(/em$/u, "")) * size * 100) / 100;
}

function lowerTextRole(value: NativeTypeStyle): NativeTextRole {
  const weightMap = FAMILY_BY_WEIGHT[value.family];
  return {
    fontFamily:
      weightMap[value.weight] ??
      weightMap["400"] ??
      weightMap["600"] ??
      family.sansRegular,
    fontSize: value.fontSize,
    lineHeight: value.lineHeight,
    ...(value.letterSpacing === undefined
      ? {}
      : { letterSpacing: emToPoints(value.letterSpacing, value.fontSize) }),
    ...(value.textTransform === undefined
      ? {}
      : { textTransform: value.textTransform }),
    ...(value.variantNumeric === undefined
      ? {}
      : { fontVariant: [value.variantNumeric] }),
  };
}

export const type = Object.fromEntries(
  Object.entries(canonicalThemes.light.type).map(([key, value]) => [
    key,
    lowerTextRole(value),
  ])
) as Record<keyof NativeTheme["type"], NativeTextRole>;

export function t(key: keyof typeof type): NativeTextRole {
  return type[key];
}

export function canonicalTheme(scheme: NativeScheme): NativeTheme {
  return canonicalThemes[scheme];
}

const shared = canonicalThemes.light;
export const borders = shared.borders;
export const density = shared.density;
export const durations = shared.durations;
export const metrics = shared.metrics;
export const pageMargin = shared.pageMargin;
export const radii = shared.radii;
export const spacing = shared.spacing;
export const targetMin = shared.targetMin;
