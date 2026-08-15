// The Home springboard — Tier-1 CONTENT tiles (issue #708 A).
//
// The brief's model: Home is made of content, not of app icons, and each tile
// is a window into the app it opens. The former four-up icon launcher had no
// live caller and was removed with its standalone icon component.
//
// The INVARIANT is the header — app icon in its identity chip, app name at the
// UI role, count in the tabular numeric register, in that order, at the same
// place, on every tile without exception. It is what makes eight structurally
// different bodies read as one grid. The bodies live in ./TileBody and are
// deliberately unlike each other.
//
// A tile is still a launcher: the whole card is one Pressable with the same
// press curve and Light haptic the icon grid had, and it routes through the
// same `onOpen(item)` Home already owned. Nothing about navigation moved.
//
// Home itself takes NO identity hue (issue #707): the hue on a tile belongs to
// the app the tile previews, and it appears only on the icon chip and the one
// place a body needs a mark (the Tasks tick). The card is paper.

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

/**
 * The press-scale curve: the brief's STATE curve (:3360, `140ms
 * cubic-bezier(.3,0,.4,1)`), not a spring — a tile's own press is a state
 * change (pressed ⇄ not), and the brief carries exactly two sanctioned curves
 * for the two cases motion covers. `withSpring` reads as physically alive,
 * which is the wrong register for "this button is now down."
 */
const PRESS_CURVE = Easing.bezier(0.3, 0, 0.4, 1);
const PRESS_DURATION = durations.one;
const CHIP_SIZE = 22;

/**
 * The grid's row FLOOR, never its height — the brief's `minmax(152px, auto)`.
 *
 * A fixed height slices the body at 150%+ text scale; a floor lets the tile
 * grow instead, while every clamp inside a body stays a `numberOfLines` clamp
 * so long content still ends on a whole line rather than a cut baseline.
 */
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
  /** Only the items that EARNED the grid — Home does the grading (./Home). */
  items: readonly LauncherItem[];
  /** Tile data by app id (./useSpringboardTiles). Missing ⇒ no content tile. */
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

  // Pull 1×1s together before a full-width tile can break the pair, so the
  // wrap never leaves a blank half-row (./grid-packing). Sizes are untouched —
  // only the ORDER moves, and only ever forwards.
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

/** The count, in the numeric register. `undefined` is withheld, never zero. */
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
  // A withheld count reads as the label alone ("Open Locker, locked"); the em
  // dash is a visual glyph and has nothing to say to a screen reader.
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
          {/* INVARIANT header. Identical structure on every tile: the chip
              carries the app's hue, the name is the UI role, the count is the
              numeric role with tabular figures so tiles align column-wise. */}
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
    // Paper, not elevation: a raised surface plus a rule, no shadow.
    card: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      // The handoff splits this as header padding-bottom 8 + body padding-top
      // 8 (`headCss` :5034 / `bodyWrapCss` :5039-5040); one `gap: 16` gets the
      // same 16 total without reaching into TileBody's own wrapper from here.
      gap: 16,
      minHeight: TILE_MIN_HEIGHT,
      // The photo mosaic bleeds past this padding; the tile clips it.
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
    // The negative margin cancels the slots' own gutter so the outer columns
    // still line up with the screen's content padding. -4 pairs with the
    // slot's own 4px halves below, for the brief's 8px mobile grid gap
    // (:5709's `mob?R.gap.s:R.gap.m`) split evenly between two neighbours.
    grid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -4 },
    header: { alignItems: "center", flexDirection: "row", gap: 8 },
    invite: { ...t("control"), color: colors.textFaint },
    // The invariant header's name sits at the 13px UI register, not the 11px
    // micro one: it is the label that makes eight unlike bodies read as one
    // grid, so it is the one thing on a tile that may never be small.
    name: { ...t("smallStrong"), color: colors.text, flex: 1 },
    // Two-up. The gap lives on the slot so the card can bleed to its own edge.
    // 8px row gap and 8px column gap (4+4 from two neighbouring slots) —
    // one uniform `gap` in the brief's CSS grid (:5709), split by hand here
    // because RN's flex-wrap grid has no equivalent to a wrapping grid's
    // shared column gutter.
    slot: { paddingBottom: 8, paddingHorizontal: 4, width: "50%" },
    // `medium` (2×1) and the flattened `large` both take the full row on the
    // two-column mobile grid — that IS 2×1 here.
    slotWide: { width: "100%" },
  });
