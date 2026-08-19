// The only React Native adapter for @centraid/design.
//
// Metro consumes the workspace package from source, so copying its values into
// a checked-in generated module adds drift without buying compatibility. This
// adapter does only the two jobs that are genuinely platform-specific:
//
//   1. map semantic weight to the concrete Expo font-family name;
//   2. lower CSS `em` tracking to React Native point tracking.
//
// Color, spacing, density, radius, motion, and type metrics remain the exact
// objects returned by the canonical typed native lowering.

import type { TextStyle } from "react-native";

import { toNativeTheme } from "@centraid/design/native";
import type {
  NativeScheme,
  NativeTheme,
  NativeTypeStyle,
} from "@centraid/design/native";

export const family = {
  // React Native's generic resolves to the platform code face without another
  // bundled font or an OS branch in the design registry.
  monoMedium: "monospace",
  monoRegular: "monospace",
  sansMedium: "InstrumentSans_600SemiBold",
  // THE 400 REGISTER RENDERS IN A 470 FACE, AND ONLY ON NATIVE. The ramp still
  // SPECIFIES weight 400 (DESIGN.md § Type) — this is the same rasterizer
  // compensation the size delta already is, applied to the other axis.
  //
  // `NATIVE_DELTA_BY_FAMILY` concedes that a phone at arm's length needs +2px
  // size and +3px leading over a desktop pane at the same role. That step
  // scales the glyph but not the stroke's optical presence, and iOS compounds
  // it: CoreText draws with grayscale antialiasing where a desktop browser
  // gets stem darkening. Same face, same token, objectively lighter strokes on
  // the phone — which is why the 400 register reads correct on desktop and
  // thin on the device, and why no edit to the shared ramp could fix one
  // without wrecking the other.
  //
  // 470 rather than the 500 that `@expo-google-fonts` ships: 500 overshot by
  // eye, and 470 is ~73% of the way from 400 to 500 in measured ink coverage.
  // The face is a derived static instance — see `assets/fonts/README.md`.
  //
  // Deliberately NOT a third rung on the ramp: nothing may ask for "470". The
  // token space is still two weights, and this is the lowering that draws one
  // of them. Web and desktop are untouched.
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
