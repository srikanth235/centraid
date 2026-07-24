// The springboard app grid (issue #498, Slice B change #4). Four-up tiles of the
// eight first-party apps, reused verbatim by the search overlay (filtered). Each
// tile is the engraved AppIcon emblem over its name.
//
// An uninstalled gateway app renders dimmed — "on your desktop" — so the phone
// always advertises the full surface; tapping it routes to pairing (Home owns
// that decision via item.route). Installed apps read at full strength.
//
// Slice C polish: a tile presses down with a restrained spring scale (reanimated
// drives it, so it never blocks the JS thread) and installed tiles give a Light
// haptic on press-in — the tactile confirmation of launching an app. The scale
// is a transform, so it stays purely visual with no layout shift. The launched
// cover's open transition is owned by the root navigator (App.tsx COVER_OPTIONS).

import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import AppIcon from '../../kit/components/AppIcon';
import { family, useTheme, type ThemeColors } from '../../kit/theme';
import type { LauncherItem } from './catalog';

// Quick, lightly-damped spring — a firm press-in, an unfussy release.
const PRESS_SPRING = { damping: 14, mass: 0.5, stiffness: 240 } as const;

export interface LauncherGridProps {
  items: readonly LauncherItem[];
  onOpen(item: LauncherItem): void;
}

export default function LauncherGrid({ items, onOpen }: LauncherGridProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.grid}>
      {items.map((item) => (
        <LauncherTile key={item.meta.id} item={item} onPress={() => onOpen(item)} styles={styles} />
      ))}
    </View>
  );
}

function LauncherTile({
  item,
  onPress,
  styles,
}: {
  item: LauncherItem;
  onPress(): void;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  const { meta, installed } = item;
  const label = installed ? `Open ${meta.name}` : `${meta.name}, on your desktop — tap to pair`;
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const pressIn = (): void => {
    scale.value = withSpring(0.94, PRESS_SPRING);
    // Only installed tiles launch on tap, so only they earn the confirming tick;
    // an uninstalled tile just routes to pairing and stays silent.
    if (installed) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };
  const pressOut = (): void => {
    scale.value = withSpring(1, PRESS_SPRING);
  };

  // The column width lives on the plain wrapper View so the four-up grid always
  // honors the `25%`; the Pressable sizes to its content and is centered in the
  // column, and `inner` handles the icon/label stacking + press scale.
  return (
    <View style={styles.tile}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        onPressIn={pressIn}
        onPressOut={pressOut}
        style={({ pressed }) => (pressed ? styles.tilePressed : undefined)}
      >
        <Animated.View style={[styles.tileInner, animStyle]}>
          <View style={installed ? undefined : styles.dimmed}>
            <AppIcon name={meta.iconKey} />
          </View>
          <Text style={[styles.tileLabel, !installed && styles.tileLabelDim]} numberOfLines={1}>
            {meta.name}
          </Text>
        </Animated.View>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Uninstalled apps recede — present but clearly "not here yet".
    dimmed: { opacity: 0.38 },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      rowGap: 20,
    },
    // The plain column slot owns the width and centers its pressable content, so
    // the four-up grid holds regardless of what the tile control renders as.
    tile: { alignItems: 'center', width: '25%' },
    // The scaling content lives on the inner view so the spring transform never
    // fights the tile's layout; icon + label stack and center here.
    tileInner: { alignItems: 'center', gap: 9 },
    tileLabel: { color: colors.ink2, fontFamily: family.sansMedium, fontSize: 12 },
    tileLabelDim: { color: colors.ink3 },
    // Scale is owned by the reanimated spring now; the press only dims.
    tilePressed: { opacity: 0.7 },
  });
