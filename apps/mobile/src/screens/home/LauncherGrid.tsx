// The Home springboard (#708 A). INVARIANT: every tile header is icon chip,
// name, count, in that order — it is what makes eight unlike bodies
// (./TileBody) read as one grid. Home takes no identity hue (#707); the hue
// belongs to the app a tile previews, on its chip alone.

import * as Haptics from "expo-haptics";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";

import { radii } from "@centraid/design";

import AppMark from "../../kit/components/AppMark";
import { Text } from "../../kit/components/NativeText";
import { borders, durations, t, useTheme } from "../../kit/theme";
import type { Scheme, ThemeColors } from "../../kit/theme";
import type { LauncherItem } from "./catalog";
import { packTiles } from "./grid-packing";
import { isWideTile } from "./springboard-policy";
import { TILE_PAD } from "./tile-model";
import type { TileData } from "./tile-model";
import TileBody from "./TileBody";

/** State curve, not a spring — a press is a state change, not physics. */
const PRESS_CURVE = Easing.bezier(0.3, 0, 0.4, 1);
const PRESS_DURATION = durations.one;
const CHIP_SIZE = 22;

/** A floor, never a height: fixed heights slice bodies at 150% text. */
const TILE_MIN_HEIGHT = 152;

function buildPressHandlers(scale: SharedValue<number>): {
  pressIn: () => void;
  pressOut: () => void;
} {
  const timing = { duration: PRESS_DURATION, easing: PRESS_CURVE };
  return {
    pressIn: () => {
      scale.value = withTiming(0.97, timing);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
    pressOut: () => {
      scale.value = withTiming(1, timing);
    },
  };
}

export interface LauncherGridProps {
  items: readonly LauncherItem[];
  tiles: ReadonlyMap<string, TileData>;
  onOpen: (item: LauncherItem) => void;
}

export default function LauncherGrid({
  items,
  tiles,
  onOpen,
}: LauncherGridProps): React.JSX.Element {
  const { colors, scheme } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // Order only, and only forwards — no blank half-rows.
  const packed = useMemo(
    () => packTiles(items, (item) => isWideTile(item.meta.id)),
    [items]
  );

  return (
    <View style={styles.grid}>
      {packed.map((item) => (
        <ContentTile
          key={item.meta.id}
          item={item}
          tile={tiles.get(item.meta.id)}
          colors={colors}
          scheme={scheme}
          styles={styles}
          onPress={() => onOpen(item)}
        />
      ))}
    </View>
  );
}

/** `undefined` is withheld, never rendered as zero. */
function countText(tile: TileData | undefined): string {
  if (!tile || tile.count === undefined) return "—";
  return tile.countCapped ? `${tile.count}+` : String(tile.count);
}

function ContentTile({
  item,
  tile,
  colors,
  scheme,
  styles,
  onPress,
}: {
  item: LauncherItem;
  tile: TileData | undefined;
  colors: ThemeColors;
  scheme: Scheme;
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
}): React.JSX.Element {
  const { meta } = item;
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const { pressIn, pressOut } = buildPressHandlers(scale);
  const count = countText(tile);
  // The em dash is a glyph; a screen reader gets the label alone.
  const spoken =
    tile?.count === undefined
      ? (tile?.countLabel ?? "")
      : `${count} ${tile.countLabel}`;
  const label = `Open ${meta.name}, ${spoken}`.trim().replace(/,$/u, "");

  return (
    <View style={[styles.slot, isWideTile(meta.id) && styles.slotWide]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        onPressIn={pressIn}
        onPressOut={pressOut}
      >
        <Animated.View style={[styles.card, animStyle]}>
          {/* Invariant header — see file top. */}
          <View style={styles.header}>
            <AppMark
              color={meta.color}
              iconKey={meta.iconKey}
              size={CHIP_SIZE}
            />
            <Text numberOfLines={1} style={styles.name}>
              {meta.name}
            </Text>
            <Text style={styles.count}>{count}</Text>
          </View>
          {tile ? (
            <TileBody
              tile={tile}
              colors={colors}
              hue={meta.color}
              scheme={scheme}
            />
          ) : (
            <View style={styles.body}>
              <Text style={styles.invite}>{meta.desc}</Text>
            </View>
          )}
        </Animated.View>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: { flex: 1 },
    card: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      gap: 16,
      minHeight: TILE_MIN_HEIGHT,
      overflow: "hidden",
      padding: TILE_PAD,
    },
    chip: {
      alignItems: "center",
      height: CHIP_SIZE,
      justifyContent: "center",
      width: CHIP_SIZE,
    },
    count: { ...t("mono"), color: colors.textFaint },
    // Cancels the slots' 4px halves so outer columns meet content padding.
    grid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -4 },
    header: { alignItems: "center", flexDirection: "row", gap: 8 },
    invite: { ...t("control"), color: colors.textFaint },
    name: { ...t("smallStrong"), color: colors.text, flex: 1 },
    slot: { paddingBottom: 8, paddingHorizontal: 4, width: "50%" },
    slotWide: { width: "100%" },
  });
