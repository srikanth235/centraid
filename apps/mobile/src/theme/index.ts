// Mobile theme — re-exports the shared design system from
// @centraid/design-tokens and resolves type styles to the actual
// font-family names produced by @expo-google-fonts. RN doesn't
// combine `fontFamily` + `fontWeight` reliably across platforms,
// so each weight becomes its own family name.
//
// Tokens (colors per theme, density, palette, radii, tile finishes) come
// from the package — this file only owns the RN-specific font resolution.
//
// Dark mode: `useTheme()` (below) returns a scheme-aware palette lowered from
// the blueprint kit's tokens.css (see tokens.generated.ts / resolve.ts). The
// legacy `colors` export stays light-only for callers that read it at module
// scope; anything that needs to follow the OS theme should call `useTheme()`.

import {
  themes,
  densities,
  spacing,
  palette,
  radii,
  fonts,
  type as typeTokens,
  tileFinish,
  TILE_VARIANTS,
} from '@centraid/design-tokens';
import type {
  Theme,
  ThemeName,
  DensityName,
  TypeKey,
  TileVariant,
  TileFinish,
} from '@centraid/design-tokens';
import type { TextStyle } from 'react-native';

// One family name per (family, weight) pair. Keep in sync with the
// imports in App.tsx — anything referenced here must be loaded there.
export const family = {
  displayBold: 'SpaceGrotesk_600SemiBold',
  displayMedium: 'SpaceGrotesk_500Medium',
  monoBold: 'JetBrainsMono_600SemiBold',
  monoMedium: 'JetBrainsMono_500Medium',
  monoRegular: 'JetBrainsMono_400Regular',
  sansBold: 'Geist_600SemiBold',
  sansMedium: 'Geist_500Medium',
  sansRegular: 'Geist_400Regular',
} as const;

type FamilyKey = 'sans' | 'display' | 'mono';

const FAMILY_BY_WEIGHT: Record<FamilyKey, Record<string, string>> = {
  display: { '500': family.displayMedium, '600': family.displayBold },
  mono: { '400': family.monoRegular, '500': family.monoMedium, '600': family.monoBold },
  sans: { '400': family.sansRegular, '500': family.sansMedium, '600': family.sansBold },
};

export const t = (key: TypeKey): Pick<TextStyle, 'fontSize' | 'lineHeight' | 'fontFamily'> => {
  const def = typeTokens[key];
  const map = FAMILY_BY_WEIGHT[def.family as FamilyKey];
  const fontFamily = map[def.weight] ?? map['400'] ?? map['500'] ?? family.sansRegular;
  return {
    fontFamily,
    fontSize: def.size,
    lineHeight: def.lineHeight,
  };
};

// `colors` is the light theme — kept for callers that read colors at module
// scope (shared components, static StyleSheets). Screens that follow dark
// mode read `useTheme().colors` instead.
export const colors: Theme = themes.light;

export { themes, densities, spacing, palette, radii, fonts, tileFinish, TILE_VARIANTS };
export type { Theme, ThemeName, DensityName, TileVariant, TileFinish };

// Dark-mode-aware theme API, lowered from the blueprint kit tokens.css.
export { useTheme } from './useTheme';
export { resolveTheme, navThemes, navThemeFor } from './resolve';
export type { ThemeValue, ThemeColors, Scheme } from './resolve';
export { lightPalette, darkPalette } from './tokens.generated';
export type { PaletteKey } from './tokens.generated';
