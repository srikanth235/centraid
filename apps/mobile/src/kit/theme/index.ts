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

export { spacing, radii } from "@centraid/design";

export {
  getAccent,
  hydrateAccent,
  setAccent,
  subscribeAccent,
  useAccent,
} from "./accent";

// One family name per (family, weight) pair. Keep in sync with the
// imports in App.tsx — anything referenced here must be loaded there.
export const family = {
  monoBold: "JetBrainsMono_600SemiBold",
  monoMedium: "JetBrainsMono_500Medium",
  monoRegular: "JetBrainsMono_400Regular",
  sansBold: "Geist_600SemiBold",
  sansMedium: "Geist_500Medium",
  sansRegular: "Geist_400Regular",
  // Playfair Display — the editorial serif used for the home greeting
  // (upright for the salutation, italic for the name). Loaded in App.tsx.
  serif: "PlayfairDisplay_600SemiBold",
  serifItalic: "PlayfairDisplay_600SemiBold_Italic",
} as const;

type FamilyKey = "sans" | "mono" | "serif";

const FAMILY_BY_WEIGHT: Record<FamilyKey, Record<string, string>> = {
  mono: {
    "400": family.monoRegular,
    "500": family.monoMedium,
    "600": family.monoBold,
  },
  sans: {
    "400": family.sansRegular,
    "500": family.sansMedium,
    "600": family.sansBold,
  },
  serif: { "600": family.serif },
};

export const t = (
  key: keyof typeof nativeType
): Pick<TextStyle, "fontSize" | "lineHeight" | "fontFamily"> => {
  const def = nativeType[key];
  const map = FAMILY_BY_WEIGHT[def.family as FamilyKey];
  const fontFamily =
    map[def.weight] ?? map["400"] ?? map["500"] ?? family.sansRegular;
  return {
    fontFamily,
    fontSize: def.fontSize,
    lineHeight: def.lineHeight,
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
