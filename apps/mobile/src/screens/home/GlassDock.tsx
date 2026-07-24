// The floating "liquid-glass" dock (issue #498, Slice B changes #2 + #5 + #6).
// A rounded pill anchored just above the home indicator, its frosted-glass
// material now comes from the shared GlassBar (Slice C) so the dock and the
// Photos bottom bar render the identical blur/tint/hairline. Two symmetric
// slots — Search · Settings — with the Assistant raised and teal at the spine,
// the app's single primary action.
//
// Gateway status is deliberately NOT a dock slot any more — it lives in the
// attention line. The two side slots keep the `selection` haptic the old tab
// bar gave; the Assistant spine — the primary action — fires a heavier `Medium`
// impact so it reads as the more consequential tap.

import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Icon from '../../kit/components/Icon';
import GlassBar from '../../kit/components/GlassBar';
import { family, useTheme, type ThemeColors } from '../../kit/theme';
import type { IconName } from '@centraid/design-tokens';

export interface GlassDockProps {
  onSearch(): void;
  onAssistant(): void;
  onSettings(): void;
}

export default function GlassDock({
  onSearch,
  onAssistant,
  onSettings,
}: GlassDockProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  // Side slots keep the light `selection` tick, then the caller navigates.
  const tap = (fn: () => void) => (): void => {
    void Haptics.selectionAsync();
    fn();
  };

  // The Assistant spine is the primary action — a heavier `Medium` impact.
  const tapAssistant = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onAssistant();
  };

  return (
    <View
      style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, 8) }]}
      pointerEvents="box-none"
    >
      <GlassBar>
        <View style={styles.slots}>
          <DockSlot
            icon="Search"
            label="Search"
            onPress={tap(onSearch)}
            styles={styles}
            colors={colors}
          />
          <View style={styles.centerGap} />
          <DockSlot
            icon="Settings"
            label="Settings"
            onPress={tap(onSettings)}
            styles={styles}
            colors={colors}
          />
        </View>
      </GlassBar>

      {/* Raised spine — sits above the pill so the blur can clip its own
          background without clipping the FAB. `box-none` lets pill taps through
          the empty layer, but the FAB itself catches its own touches. */}
      <View style={styles.fabLayer} pointerEvents="box-none">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Assistant"
          onPress={tapAssistant}
          style={({ pressed }) => [styles.fab, pressed && { opacity: 0.85 }]}
        >
          <View style={styles.fabHighlight} pointerEvents="none" />
          <Icon name="Sparkle" size={26} color="#fff" strokeWidth={1.6} />
        </Pressable>
      </View>
    </View>
  );
}

function DockSlot({
  icon,
  label,
  onPress,
  styles,
  colors,
}: {
  icon: IconName;
  label: string;
  onPress(): void;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.slot, pressed && { opacity: 0.6 }]}
    >
      <Icon name={icon} size={22} color={colors.ink2} strokeWidth={1.8} />
      <Text style={styles.slotLabel}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    centerGap: { width: 76 },
    fab: {
      alignItems: 'center',
      backgroundColor: colors.accent,
      borderRadius: 30,
      elevation: 8,
      height: 60,
      justifyContent: 'center',
      overflow: 'hidden',
      shadowColor: colors.accent,
      shadowOffset: { height: 8, width: 0 },
      shadowOpacity: 0.45,
      shadowRadius: 14,
      width: 60,
    },
    fabHighlight: {
      backgroundColor: 'rgba(255,255,255,0.22)',
      borderTopLeftRadius: 30,
      borderTopRightRadius: 30,
      height: '52%',
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    fabLayer: {
      alignItems: 'center',
      left: 0,
      position: 'absolute',
      right: 0,
      // Raise the spine so it straddles the pill's top edge.
      top: -22,
    },
    slot: { alignItems: 'center', gap: 3, paddingHorizontal: 18, paddingVertical: 4 },
    slotLabel: { color: colors.ink2, fontFamily: family.sansMedium, fontSize: 10 },
    slots: {
      alignItems: 'center',
      flexDirection: 'row',
      height: 60,
      justifyContent: 'space-between',
      paddingHorizontal: 14,
    },
    wrap: {
      alignItems: 'center',
      bottom: 0,
      left: 0,
      paddingHorizontal: 24,
      position: 'absolute',
      right: 0,
    },
  });
