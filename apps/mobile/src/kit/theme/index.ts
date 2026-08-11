// Mobile theme — re-exports the shared design system from
// @centraid/design and resolves type styles to the actual
// font-family names produced by @expo-google-fonts. RN doesn't
// combine `fontFamily` + `fontWeight` reliably across platforms,
// so each weight becomes its own family name.
//
// Tokens (colors per theme, density, palette, radii, tile finishes) come
// from the package — this file only owns the RN-specific font resolution.
//
// Dark mode: `useTheme()` (below) returns a scheme-aware palette lowered from
// the canonical blueprint token source (see tokens.generated.ts / resolve.ts). The
// legacy `colors` export stays light-only for callers that read it at module
// scope; anything that needs to follow the OS theme should call `useTheme()`.

import type { TextStyle } from "react-native";

import { type as nativeType } from "./tokens.generated";

export { spacing, radii, borders } from "@centraid/design";
export { density, metrics, pageMargin } from "./tokens.generated";

// One family name per (family, weight) pair. Keep in sync with the
// imports in App.tsx — anything referenced here must be loaded there.
//
// The Binding Layer's ramp carries exactly four faces, two registers each
// where the face ships both: Schibsted Grotesk for body/UI text, Instrument
// Serif for the display role, Source Serif 4 for the reading register, and
// Spline Sans Mono for the numeric register. The `Regular`/`Medium` suffixes
// name the REGISTER, not the weight — on the sans the regular register is
// the 500 cut and the strong register the 600 (see the weight rationale atop
// packages/design/src/typography.ts). There is no rung above the strong
// register — a caller that used to reach for `sansBold` reaches for
// `sansMedium`, the heaviest the ramp has.
export const family = {
  displayItalic: "InstrumentSerif_400Regular_Italic",
  displayRegular: "InstrumentSerif_400Regular",
  monoMedium: "SplineSansMono_500Medium",
  monoRegular: "SplineSansMono_400Regular",
  sansMedium: "SchibstedGrotesk_600SemiBold",
  sansRegular: "SchibstedGrotesk_500Medium",
  serifRegular: "SourceSerif4_400Regular",
} as const;

type FamilyKey = "display" | "sans" | "mono" | "serif";

const FAMILY_BY_WEIGHT: Record<FamilyKey, Record<string, string>> = {
  display: { "400": family.displayRegular },
  mono: {
    "400": family.monoRegular,
    "500": family.monoMedium,
  },
  sans: {
    "500": family.sansRegular,
    "600": family.sansMedium,
  },
  serif: { "400": family.serifRegular },
};

type NativeTypeValue = (typeof nativeType)[keyof typeof nativeType];

export const t = (
  key: keyof typeof nativeType
): Pick<
  TextStyle,
  | "fontSize"
  | "lineHeight"
  | "fontFamily"
  | "letterSpacing"
  | "textTransform"
  | "fontVariant"
> => {
  const def = nativeType[key] as NativeTypeValue & {
    letterSpacing?: number;
    textTransform?: "uppercase";
    fontVariant?: TextStyle["fontVariant"];
  };
  const map = FAMILY_BY_WEIGHT[def.family as FamilyKey];
  const fontFamily =
    map[def.weight] ?? map["500"] ?? map["400"] ?? family.sansRegular;
  return {
    fontFamily,
    fontSize: def.fontSize,
    lineHeight: def.lineHeight,
    // Tracking, caps and tabular figures are part of the ROLE, not decoration
    // a caller adds on top (see generate.ts#renderType) — a role that carries
    // one of these on the typed lowering must carry it here too, or "numerics
    // are mono and tabular in every app, without exception" silently stops
    // being true the moment a screen calls `t("mono")` instead of hand-rolling
    // the style.
    ...(def.letterSpacing === undefined
      ? {}
      : { letterSpacing: def.letterSpacing }),
    ...(def.textTransform === undefined
      ? {}
      : { textTransform: def.textTransform }),
    ...(def.fontVariant === undefined
      ? {}
      : { fontVariant: def.fontVariant as TextStyle["fontVariant"] }),
  };
};

// Dark-mode-aware theme API, lowered from the canonical blueprint token source.
export { useTheme } from "./useTheme";
export { resolveTheme, navThemeFor } from "./resolve";
export type { ThemeColors, Scheme } from "./resolve";

// Device-local Appearance override (System / Light / Dark) folded over the OS.
export {
  useAppearance,
  setAppearance,
  hydrateAppearance,
  resolveScheme,
} from "./appearance";
export type { Appearance } from "./appearance";
