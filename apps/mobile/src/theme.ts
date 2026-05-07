// Mobile theme — re-exports shared tokens and resolves them to the actual
// font-family names produced by @expo-google-fonts. RN doesn't combine
// `fontFamily` + `fontWeight` reliably across platforms, so each weight
// becomes its own family name.

import {
  colors,
  palette,
  radii,
  spacing,
  type as typeTokens,
  fonts,
} from '@centraid/design-tokens';
import type { TypeKey } from '@centraid/design-tokens';
import type { TextStyle } from 'react-native';

// One family name per (family, weight) pair. Keep in sync with the imports
// in App.tsx — anything referenced here must be loaded there.
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

export { colors, palette, radii, spacing, fonts };
