import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { IconName } from '@centraid/design-tokens';
import Icon from './Icon';
import { useTheme } from '../theme/useTheme';

// The "Pressed Card" launcher icon: a monochrome engraved emblem stamped into a
// translucent glass tile. There is no per-app colour — apps are told apart by
// silhouette, which is the point of the engraved direction. The pressed-in look
// is faked with a two-layer emblem (an offset highlight/shadow copy behind the
// ink copy), since React Native has no CSS `filter: drop-shadow`.
//
// Slice C polish: the tile paper is now semi-translucent (an rgba of the aged
// paper / near-black tones) with a hairline light border, so the cream canvas
// (or the dark ground) breathes through the tile the way the mock's engraved
// glyph sits on frosted glass. The two-layer deboss is preserved exactly.
//
// These paper/ink values are icon-local on purpose: they are not part of the
// app's colour ramp, so they live here rather than in the generated theme tokens
// (and a translucent tile must be rgba, which the opaque palette tokens are not).
const ENGRAVED = {
  light: {
    paper: 'rgba(231, 221, 202, 0.55)', // aged paper, translucent so canvas shows through
    ink: '#5b4a2c',
    deboss: 'rgba(255,251,243,0.9)', // light catches the bottom of the groove
    border: 'rgba(255, 252, 245, 0.65)', // luminous hairline — the glass edge
    sheen: 'rgba(255,252,245,0.7)',
    shadowOpacity: 0.16,
  },
  dark: {
    paper: 'rgba(32, 36, 44, 0.55)', // near-black card, translucent over the dark ground
    ink: '#d8cfba',
    deboss: 'rgba(0,0,0,0.55)', // a dark drop lifts the light ink off the card
    border: 'rgba(255,255,255,0.12)', // faint light hairline — the glass edge
    sheen: 'rgba(255,255,255,0.05)',
    shadowOpacity: 0.4,
  },
} as const;

export interface AppIconProps {
  name: IconName;
  size?: number;
}

export default function AppIcon({ name, size = 62 }: AppIconProps): React.JSX.Element {
  const { scheme } = useTheme();
  const t = ENGRAVED[scheme];
  const glyph = Math.round(size * 0.48);
  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.29),
          backgroundColor: t.paper,
          borderColor: t.border,
          shadowOpacity: t.shadowOpacity,
        },
      ]}
    >
      <View pointerEvents="none" style={[styles.sheen, { backgroundColor: t.sheen }]} />
      <View pointerEvents="none" style={styles.debossLayer}>
        <View style={styles.debossOffset}>
          <Icon name={name} size={glyph} color={t.deboss} strokeWidth={1.9} />
        </View>
      </View>
      <Icon name={name} size={glyph} color={t.ink} strokeWidth={1.9} />
    </View>
  );
}

const styles = StyleSheet.create({
  debossLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  debossOffset: { transform: [{ translateY: 1 }] },
  sheen: {
    borderRadius: 1,
    height: 1.5,
    left: 8,
    position: 'absolute',
    right: 8,
    top: 1,
  },
  tile: {
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 3,
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { height: 3, width: 0 },
    shadowRadius: 6,
  },
});
