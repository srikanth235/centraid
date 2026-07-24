import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import { useTheme } from '../theme';
import GlassBar from './GlassBar';

// The one "leave this mini-app for your apps" key, shared by every full-page app
// cover so the escape hatch looks and lands the same everywhere. Design grammar:
//
//   • teal (`colors.accent`) + a GRID glyph  = "leave to the springboard"
//     (the launcher is a grid of your apps — never a house, which in a super-app
//     reads ambiguously as either this app's home OR the launcher's).
//   • an app's own accent + a chevron        = "up one level, still in this app"
//     (Docs folder→parent, Photos album→grid). That stays the caller's own
//     control — this key is only ever the app-exit.
//
// The caller owns the dismissal (pop the cover). Three placements of the same
// frosted-teal-glass grid disc — they differ only in where they sit:
//   • 'floating' — absolute, centered on the bottom edge, for covers with no
//     bottom bar of their own (Insights). `box-none` on the full-width wrap lets
//     taps either side of the disc fall through to the content beneath.
//   • 'leave'    — layout-agnostic disc the caller seats as the LEADING control of
//     a header row (Assistant, Automations, Docs root, Agenda), vertically
//     centered against the title + subtitle.
//   • 'bar'      — a larger disc sized to sit inline in a bottom bar row, detached
//     to the left of an app's tab pill (Photos), mirroring the "+" create disc on
//     the right.
//
// The teal wash is BRAND_TEAL at low alpha — a quiet tint that reads as system
// furniture, not a shouting button (no solid fill). Like GlassBar's TINT it is
// hardcoded because the palette tokens are opaque and a wash must be translucent;
// this is the same teal as `accent` on both schemes (see theme/resolve.ts).
const TEAL_WASH = 'rgba(18, 138, 120, 0.08)';

// Diameter of the floating disc. ≥44 keeps it a comfortable tap target; the
// GlassBar radius is half this so the pill clips to a true circle.
const FLOAT_SIZE = 54;

// Diameter of the header-leading disc. A touch smaller than the floating key — it
// reads as header chrome sitting beside a large title, not the page's primary
// exit — while staying at the 40pt tap-target floor.
const HEADER_SIZE = 40;

// Diameter of the in-bar disc. Matches the Photos "+" FAB so the tab pill is
// flanked by two equal discs — one to leave (teal, left), one to create (right).
const BAR_SIZE = 56;

export interface HomeKeyProps {
  onPress: () => void;
  variant: 'floating' | 'leave' | 'bar';
}

export default function HomeKey({ onPress, variant }: HomeKeyProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  // Leave: a bare glass disc the caller seats as the leading control of a header
  // row (Assistant/Automations/Docs/Agenda).
  if (variant === 'leave') {
    return (
      <GlassBar radius={HEADER_SIZE / 2}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to your apps"
          onPress={onPress}
          style={styles.headerKey}
        >
          <View style={styles.wash} pointerEvents="none" />
          <Feather name="grid" size={19} color={colors.accent} />
        </Pressable>
      </GlassBar>
    );
  }

  // Bar: a larger inline disc, detached to the left of an app's tab pill.
  if (variant === 'bar') {
    return (
      <GlassBar radius={BAR_SIZE / 2}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to your apps"
          onPress={onPress}
          style={styles.barKey}
        >
          <View style={styles.wash} pointerEvents="none" />
          <Feather name="grid" size={22} color={colors.accent} />
        </Pressable>
      </GlassBar>
    );
  }

  // Floating: an icon-only glass disc centered along the bottom edge. Centered
  // (not corner-anchored) so it reads as a deliberate "return to springboard"
  // affordance — rhyming with the Home screen's own centered dock FAB — instead
  // of a lone Android-style corner button.
  return (
    <View
      style={[styles.floatWrap, { paddingBottom: Math.max(insets.bottom, 10) }]}
      pointerEvents="box-none"
    >
      <GlassBar radius={FLOAT_SIZE / 2}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to your apps"
          onPress={onPress}
          style={styles.floatKey}
        >
          <View style={styles.wash} pointerEvents="none" />
          <Feather name="grid" size={22} color={colors.accent} />
        </Pressable>
      </GlassBar>
    </View>
  );
}

const styles = StyleSheet.create({
  barKey: {
    alignItems: 'center',
    height: BAR_SIZE,
    justifyContent: 'center',
    overflow: 'hidden',
    width: BAR_SIZE,
  },
  floatKey: {
    alignItems: 'center',
    height: FLOAT_SIZE,
    justifyContent: 'center',
    overflow: 'hidden',
    width: FLOAT_SIZE,
  },
  floatWrap: { alignItems: 'center', bottom: 0, left: 0, position: 'absolute', right: 0 },
  headerKey: {
    alignItems: 'center',
    height: HEADER_SIZE,
    justifyContent: 'center',
    overflow: 'hidden',
    width: HEADER_SIZE,
  },
  wash: { ...StyleSheet.absoluteFillObject, backgroundColor: TEAL_WASH },
});
