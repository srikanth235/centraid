// The Home springboard — Tier-1 CONTENT tiles (issue #708 A).
//
// This replaces the four-up icon launcher (kept at ./LauncherIconGrid for the
// search overlay, where the user is identifying an app rather than previewing
// it). The brief's model: Home is made of content, not of app icons, and each
// tile is a window into the app it opens.
//
// The INVARIANT is the header — app icon in its identity chip, app name at the
// UI role, count in the tabular numeric register, in that order, at the same
// place, on every tile without exception. It is what makes eight structurally
// different bodies read as one grid. The bodies live in ./TileBody and are
// deliberately unlike each other.
//
// A tile is still a launcher: the whole card is one Pressable with the same
// press spring and Light haptic the icon grid had, and it routes through the
// same `onOpen(item)` Home already owned. Nothing about navigation moved.
//
// Home itself takes NO identity hue (issue #707): the hue on a tile belongs to
// the app the tile previews, and it appears only on the icon chip and the one
// place a body needs a mark (the Tasks tick). The card is paper.

import * as Haptics from "expo-haptics";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";

import { HOME_SEARCH_EVERYTHING } from "@centraid/client/home-copy";
import { iconChipFinish, iconChipRadius, radii } from "@centraid/design";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { density, t, useTheme } from "../../kit/theme";
import type { Scheme, ThemeColors } from "../../kit/theme";
import type { LauncherItem } from "./catalog";
import FirstRunGrid from "./FirstRunGrid";
import { isWideTile, springboardState } from "./tile-model";
import type { TileData } from "./tile-model";
import TileBody from "./TileBody";

const PRESS_SPRING = { damping: 14, mass: 0.5, stiffness: 240 } as const;
const CHIP_SIZE = 26;

/**
 * Mobile renders one tier looser than declared (packages/design/src/density),
 * and Home declares `comfortable`, so the tile's content padding is the
 * comfortable rung and its rows breathe accordingly.
 */
const TILE_PAD = density.comfortable.pad - 2;

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
  return {
    pressIn: () => {
      scale.value = withSpring(0.97, PRESS_SPRING);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
    pressOut: () => {
      scale.value = withSpring(1, PRESS_SPRING);
    },
  };
}

/**
 * Home's own cross-app search entry point — the third of the brief's three
 * (⌘K on desktop, the stem/band's Search control, "Search everything" here).
 *
 * It opens the SAME overlay the header's search control opens: three doors, one
 * room. A bounded control rather than bare text, because mobile has no hover to
 * make a word look like an action.
 */
function SearchEverything({
  colors,
  styles,
  onPress,
}: {
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={HOME_SEARCH_EVERYTHING}
      onPress={onPress}
      style={({ pressed }) => [styles.search, pressed && styles.searchPressed]}
    >
      <Icon name="Search" size={15} color={colors.textSoft} />
      <Text style={styles.searchLabel}>{HOME_SEARCH_EVERYTHING}</Text>
    </Pressable>
  );
}

export interface LauncherGridProps {
  items: readonly LauncherItem[];
  /** Tile data by app id (./useSpringboardTiles). Missing ⇒ no content tile. */
  tiles: ReadonlyMap<string, TileData>;
  onOpen: (item: LauncherItem) => void;
  /** Opens the search overlay Home already owns — never a second search. */
  onSearch: () => void;
}

export default function LauncherGrid({
  items,
  tiles,
  onOpen,
  onSearch,
}: LauncherGridProps): React.JSX.Element {
  const { colors, scheme } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // Only the apps that actually have a tile vote on first-run. A user-built
  // gateway app has no read path here, so counting it would make the vault
  // look non-empty forever.
  const state = useMemo(
    () =>
      springboardState(
        items.flatMap((item) => {
          const tile = tiles.get(item.meta.id);
          return tile ? [tile] : [];
        })
      ),
    [items, tiles]
  );

  // Search sits above every treatment, first run included: it is the one thing
  // that works before the grid has anything to say.
  const search = (
    <SearchEverything colors={colors} styles={styles} onPress={onSearch} />
  );

  if (state === "first-run")
    return (
      <View>
        {search}
        <FirstRunGrid items={items} onOpen={onOpen} />
      </View>
    );

  return (
    <View>
      {search}
      <View style={styles.grid}>
        {items.map((item) => (
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
  const { meta, installed } = item;
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const { pressIn, pressOut } = buildPressHandlers(scale);
  const finish = iconChipFinish(meta.color, colors.bg, scheme);
  const count = countText(tile);
  // A withheld count reads as the label alone ("Open Locker, locked"); the em
  // dash is a visual glyph and has nothing to say to a screen reader.
  const spoken =
    tile?.count === undefined
      ? (tile?.countLabel ?? "")
      : `${count} ${tile.countLabel}`;
  const label = installed
    ? `Open ${meta.name}, ${spoken}`.trim().replace(/,$/u, "")
    : `${meta.name}, on your desktop — tap to pair`;

  return (
    <View style={[styles.slot, isWideTile(meta.id) && styles.slotWide]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        onPressIn={pressIn}
        onPressOut={pressOut}
        style={({ pressed }) => (pressed ? styles.pressed : undefined)}
      >
        <Animated.View style={[styles.card, animStyle]}>
          {/* INVARIANT header. Identical structure on every tile: the chip
              carries the app's hue, the name is the UI role, the count is the
              numeric role with tabular figures so tiles align column-wise. */}
          <View style={styles.header}>
            <View
              style={[
                styles.chip,
                {
                  backgroundColor: installed
                    ? finish.backgroundColor
                    : colors.bgSunken,
                  borderRadius: iconChipRadius(CHIP_SIZE),
                },
              ]}
            >
              <Icon
                name={meta.iconKey}
                size={15}
                color={installed ? finish.markColor : colors.textFaint}
              />
            </View>
            <Text numberOfLines={1} style={styles.name}>
              {meta.name}
            </Text>
            <Text style={styles.count}>{count}</Text>
          </View>
          {tile ? (
            <TileBody tile={tile} colors={colors} hue={meta.color} />
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
    // Paper, not elevation: a raised surface plus a hairline rule, no shadow.
    card: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: StyleSheet.hairlineWidth,
      gap: 10,
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
    // still line up with the screen's content padding.
    grid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -5 },
    header: { alignItems: "center", flexDirection: "row", gap: 8 },
    invite: { ...t("control"), color: colors.textFaint },
    name: { ...t("control"), color: colors.text, flex: 1 },
    pressed: { opacity: 0.9 },
    search: {
      alignItems: "center",
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 8,
      marginBottom: 14,
      minHeight: 34,
      paddingHorizontal: 12,
    },
    searchLabel: { ...t("control"), color: colors.textSoft },
    // A recessive state gets its own colour token on the leaf, never a
    // container opacity.
    searchPressed: { backgroundColor: colors.bgPress },
    // Two-up. The gap lives on the slot so the card can bleed to its own edge.
    slot: { paddingBottom: 12, paddingHorizontal: 5, width: "50%" },
    // `medium` (2×1) and the flattened `large` both take the full row on the
    // two-column mobile grid — that IS 2×1 here.
    slotWide: { width: "100%" },
  });
