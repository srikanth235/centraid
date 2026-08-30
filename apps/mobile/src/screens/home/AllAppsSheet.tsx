// Tier 2: "All apps and places" — the sheet the band's More tab opens
// (handoff :3123-3247).
//
// Every installed app is a 44px row (mark, count, pin switch); PINNING WRITES
// THE HOME GRID ORDER — a grid scrolls, so a pin lifts without a cap. The
// "places" half is the full ./places table; Home is pinned by law and shows
// "by law" instead of a switch, and the Assistant lives in the apps half
// (:3482), never a place. Each half gets its own sub-head in handoff copy
// (:5484-5485).
//
// Recency is NOT shown (no per-app last-opened record). Counts are real; a
// withheld count renders withheld, never zero. Modal, not ActionSheetIOS:
// search + per-row switches need real layout.

import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import AppMark from "../../kit/components/AppMark";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { TEST_IDS, TEST_ID_PREFIXES } from "../../kit/test-ids";
import { borders, family, metrics, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { LauncherItem } from "./catalog";
import { togglePlacePin, usePlacePins } from "./home-pins";
import {
  enabledPlacePins,
  enabledPlaces,
  isPlacePinned,
  pinnedPlaces,
} from "./places";
import type { Place } from "./places";
import type { TileData } from "./tile-model";

const ROW_ICON = 28;

export const ALL_APPS_TITLE = "All apps and places";

export interface AllAppsSheetProps {
  visible: boolean;
  /** Every installed app, already in the member's pin order (Home applies it). */
  items: readonly LauncherItem[];
  /** Tile data by app id, for the real count beside each row. */
  tiles: ReadonlyMap<string, TileData>;
  pinnedIds: readonly string[];
  onOpenApp: (item: LauncherItem) => void;
  onOpenPlace: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onClose: () => void;
}

function matchesQuery(name: string, query: string): boolean {
  if (!query) return true;
  return name.toLowerCase().includes(query.toLowerCase());
}

/** The count, in the numeric register. `undefined` is withheld, never zero. */
function countText(tile: TileData | undefined): string {
  if (!tile || tile.count === undefined) return "—";
  const figure = tile.countCapped ? `${tile.count}+` : String(tile.count);
  return `${figure} ${tile.countLabel}`;
}

export default function AllAppsSheet({
  visible,
  items,
  tiles,
  pinnedIds,
  onOpenApp,
  onOpenPlace,
  onTogglePin,
  onClose,
}: AllAppsSheetProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const placePins = usePlacePins();
  const trimmed = query.trim();
  const apps = useMemo(
    () => items.filter((item) => matchesQuery(item.meta.name, trimmed)),
    [items, trimmed]
  );
  // A place this gateway does not serve is not listed or pinnable here —
  // see `places.ts` for unknown ≠ off.
  const { features } = useReplica();
  const places = useMemo(
    () =>
      enabledPlaces(features).filter((place) =>
        matchesQuery(place.name, trimmed)
      ),
    [trimmed, features]
  );
  // Foot formula (:5990-5991): pinned apps over installed; pinned places
  // (Home counts as pinned by law) over served places.
  const footText = `${pinnedSet.size} of ${items.length} apps · ${
    pinnedPlaces(enabledPlacePins(placePins, features)).length
  } of ${enabledPlaces(features).length} places`;

  return (
    <Modal
      transparent
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityLabel="Close all apps and places"
        style={styles.scrim}
        onPress={onClose}
      />
      <View
        style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}
        testID={TEST_IDS.home.allApps}
      >
        <View style={styles.header}>
          <Text style={styles.title}>{ALL_APPS_TITLE}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            style={styles.closeButton}
          >
            <Icon name="X" size={16} color={colors.text} />
          </Pressable>
        </View>
        <View style={styles.field}>
          <Icon name="Search" size={16} color={colors.textFaint} />
          <TextInput
            accessibilityLabel="Search all apps and places"
            value={query}
            onChangeText={setQuery}
            placeholder="Search apps and places"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
        </View>
        <ScrollView
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {apps.length > 0 ? (
            <Text style={styles.sectionHead}>
              Apps · pinned apps appear on Home
            </Text>
          ) : null}
          {apps.map((item) => (
            <AppRow
              key={item.meta.id}
              item={item}
              tile={tiles.get(item.meta.id)}
              colors={colors}
              styles={styles}
              pinned={pinnedSet.has(item.meta.id)}
              onOpen={() => {
                onClose();
                onOpenApp(item);
              }}
              onTogglePin={(next) => onTogglePin(item.meta.id, next)}
            />
          ))}
          {places.length > 0 ? (
            <Text style={styles.sectionHead}>
              Places · pinned places appear in the launcher
            </Text>
          ) : null}
          {places.map((place) => (
            <PlaceRow
              key={place.id}
              place={place}
              colors={colors}
              styles={styles}
              pinned={isPlacePinned(placePins, place.id)}
              onOpen={() => {
                onClose();
                onOpenPlace(place.id);
              }}
              onTogglePin={(next) => togglePlacePin(place.id, next)}
            />
          ))}
          {apps.length === 0 && places.length === 0 ? (
            <Text style={styles.empty}>
              Nothing matches &ldquo;{trimmed}&rdquo;.
            </Text>
          ) : null}
        </ScrollView>
        <View style={styles.foot}>
          <Text style={styles.footText}>{footText}</Text>
        </View>
      </View>
    </Modal>
  );
}

function AppRow({
  item,
  tile,
  colors,
  styles,
  pinned,
  onOpen,
  onTogglePin,
}: {
  item: LauncherItem;
  tile: TileData | undefined;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  pinned: boolean;
  onOpen: () => void;
  onTogglePin: (pinned: boolean) => void;
}): React.JSX.Element {
  const { meta } = item;
  const count = countText(tile);
  const label = `Open ${meta.name}, ${count}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onOpen}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <AppMark color={meta.color} iconKey={meta.iconKey} size={ROW_ICON} />
      {/* Pinned reads full-weight ink; unpinned a lighter name, never dimmed. */}
      <View style={styles.rowText}>
        <Text
          style={[styles.rowLabel, pinned && styles.rowLabelPinned]}
          numberOfLines={1}
        >
          {meta.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {count}
        </Text>
      </View>
      <Switch
        value={pinned}
        onValueChange={onTogglePin}
        trackColor={{ false: colors.line, true: colors.accent }}
        thumbColor={pinned ? colors.textInv : colors.textFaint}
        accessibilityLabel={`${pinned ? "Unpin" : "Pin"} ${meta.name} on Home`}
      />
    </Pressable>
  );
}

function PlaceRow({
  place,
  colors,
  styles,
  pinned,
  onOpen,
  onTogglePin,
}: {
  place: Place;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  pinned: boolean;
  onOpen: () => void;
  onTogglePin: (pinned: boolean) => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${place.name}. ${place.what}`}
      onPress={onOpen}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      // Settings is reached from HERE, not from a drawer: `home-place-settings`
      // is the handle for it (there is no vault drawer on this shell).
      testID={`${TEST_ID_PREFIXES.homePlace}${place.id}`}
    >
      {/* Places own no hue: bare mark in the faintest ink token — nothing
          here is "current". */}
      <View style={styles.chip}>
        <Icon name={place.icon} size={16} color={colors.textFaint} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel} numberOfLines={1}>
          {place.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {place.what}
        </Text>
      </View>
      {/* Home has no switch — it is in the launcher by law (:3222-3239). */}
      {place.law ? (
        <Text style={styles.lawLabel}>by law</Text>
      ) : (
        <Switch
          value={pinned}
          onValueChange={onTogglePin}
          trackColor={{ false: colors.line, true: colors.accent }}
          thumbColor={pinned ? colors.textInv : colors.textFaint}
          accessibilityLabel={`${pinned ? "Unpin" : "Pin"} ${place.name}`}
        />
      )}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    chip: {
      alignItems: "center",
      height: ROW_ICON,
      justifyContent: "center",
      width: ROW_ICON,
    },
    closeButton: {
      alignItems: "center",
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      height: 34,
      justifyContent: "center",
      width: 34,
    },
    empty: { ...t("small"), color: colors.textSoft, paddingVertical: 20 },
    field: {
      alignItems: "center",
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      flexDirection: "row",
      gap: 8,
      height: 44,
      marginHorizontal: 20,
      marginTop: 4,
      paddingHorizontal: 12,
    },
    foot: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      paddingHorizontal: 20,
      paddingVertical: 12,
    },
    footText: { ...t("mono"), color: colors.textFaint },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      marginBottom: 4,
      paddingHorizontal: 20,
    },
    input: { ...t("body"), color: colors.text, flex: 1, padding: 0 },
    // "by law" fills the switch slot, same mono numeric register (:3226, :5479).
    lawLabel: { ...t("mono"), color: colors.textFaint, textAlign: "center" },
    list: { marginTop: 8, maxHeight: 440 },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      minHeight: metrics.row,
      paddingHorizontal: 20,
      paddingVertical: 4,
    },
    rowLabel: { ...t("small"), color: colors.text },
    rowLabelPinned: { ...t("smallStrong"), color: colors.text },
    rowMeta: { ...t("mono"), color: colors.textFaint },
    rowPressed: { backgroundColor: colors.bgHover },
    rowText: { flex: 1 },
    scrim: { backgroundColor: colors.scrim, flex: 1 },
    // One style for both sub-heads (:5482-5485); border-top separates halves.
    sectionHead: {
      borderTopColor: colors.lineStrong,
      borderTopWidth: borders.hairline,
      color: colors.textFaint,
      fontFamily: family.sansRegular,
      fontSize: t("control").fontSize,
      letterSpacing: 0.7,
      marginTop: 8,
      paddingBottom: 4,
      paddingHorizontal: 20,
      paddingTop: 12,
      textTransform: "uppercase",
    },
    // Elevated ground + hairline all round (:5976-5978).
    sheet: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderTopLeftRadius: radii.lg,
      borderTopRightRadius: radii.lg,
      borderWidth: borders.hairline,
      maxHeight: "80%",
    },
    title: {
      color: colors.text,
      flex: 1,
      fontFamily: family.sansMedium,
      fontSize: t("body").fontSize,
    },
  });
