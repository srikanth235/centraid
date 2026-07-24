// Shared "liquid-glass" pill chrome (issue #498, Slice C polish). Reused by the
// home GlassDock, the Photos bottom bar, and the HomeKey circle so one glass
// idiom lives in one place.
//
// The material is a live expo-blur BlurView (real backdrop blur of whatever
// scrolls behind the pill), a thin scheme-tinted film over it to keep the
// cream / near-black cast, a faint top sheen for the curved-glass highlight, a
// hairline edge and a shadow lift. The BlurView needs its native module compiled
// into the app binary — the JS package alone renders as "Unimplemented
// component", so this requires a native build (pod install + run:ios), not just
// a JS bundle.
//
// The tint + sheen are the one place this hardcodes colour: they must be
// semi-transparent and the palette tokens are all opaque. Light echoes bgElev
// (#fbf8f1) so the pill reads as cream glass; dark is a cool near-black. Alpha
// stays low so the live blur reads through — the blur carries the "glass", the
// film only colours it.

import React, { useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { useTheme, type ThemeColors, type Scheme } from '../theme';

// A light colour cast over the live blur — not an opaque fill.
const TINT: Record<Scheme, string> = {
  light: 'rgba(251, 248, 241, 0.5)',
  dark: 'rgba(24, 28, 34, 0.42)',
};

// A faint light sheen along the top half sells the curved-glass highlight.
const SHEEN: Record<Scheme, string> = {
  light: 'rgba(255, 255, 255, 0.4)',
  dark: 'rgba(255, 255, 255, 0.05)',
};

export interface GlassBarProps {
  children: React.ReactNode;
  // Corner radius of the pill. Defaults to the dock's 30.
  radius?: number;
  // Backdrop-blur strength passed to the BlurView (0–100). Defaults to a soft 36.
  intensity?: number;
  style?: StyleProp<ViewStyle>;
}

export default function GlassBar({
  children,
  radius = 30,
  intensity = 36,
  style,
}: GlassBarProps): React.JSX.Element {
  const { colors, scheme } = useTheme();
  const styles = useMemo(() => makeStyles(colors, scheme), [colors, scheme]);
  return (
    <View style={[styles.pill, { borderRadius: radius }, style]}>
      <BlurView
        intensity={intensity}
        tint={scheme === 'dark' ? 'dark' : 'light'}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={[StyleSheet.absoluteFill, styles.tint]} pointerEvents="none" />
      <View
        style={[styles.sheen, { borderTopLeftRadius: radius, borderTopRightRadius: radius }]}
        pointerEvents="none"
      />
      {children}
    </View>
  );
}

const makeStyles = (colors: ThemeColors, scheme: Scheme) =>
  StyleSheet.create({
    pill: {
      borderColor: colors.line,
      borderWidth: StyleSheet.hairlineWidth,
      // Elevation/shadow lifts the glass off the canvas on both platforms.
      elevation: 6,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { height: 6, width: 0 },
      shadowOpacity: scheme === 'dark' ? 0.4 : 0.14,
      shadowRadius: 16,
    },
    sheen: {
      backgroundColor: SHEEN[scheme],
      height: '52%',
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    tint: { backgroundColor: TINT[scheme] },
  });
