// Tier 2: "All apps and places" — the sheet the band's More tab opens
// (handoff :3123-3247, :5469-5485, :5990-5993).
//
// A searchable list where every installed app is a 44px row with its mark, its
// count, and a pin switch, and PINNING WRITES THE HOME GRID ORDER. Pinning
// into the grid is the brief's own Tier-2 wording — a grid scrolls, so a pin
// can lift an app to the front without a cap and without anything being
// pushed off the screen.
//
// The "and places" half is now the full eleven-row table in ./places, not the
// two-item stand-in (Assistant, Settings) this used to carry: every place a
// 44px row with its mark, its `what` line, and a pin switch — except Home,
// which is pinned by law and shows "by law" instead (Home cannot be unpinned,
// the way a browser cannot unpin its own back button). The Assistant is NOT
// here — it moved to the apps half, because the handoff settles it as "a
// pinned app, reached from the app surface, from ⌘K, and from New chat"
// (:3482), never a place the frame goes.
//
// Each half gets its own sub-head, in the handoff's own copy (:5484-5485):
// "Apps · pinned apps appear on Home" and "Places · pinned places appear in
// the launcher" — so a list mixing two kinds of thing says so, rather than
// making a member read it twice to find out.
//
// Recency is specified for app rows and is NOT shown, because this app keeps
// no per-app last-opened record; a fabricated "2 days ago" on a launcher row is
// exactly the kind of number a member would plan around. The count beside each
// row IS real — the same count the tile draws — and a withheld count (Locker)
// renders withheld rather than as a zero.
//
// Cross-platform Modal (not ActionSheetIOS): the search field and per-row
// switch need real layout, and the brief asks for identical iOS/Android
// behaviour beyond safe-area handling.

import React, { useMemo, useState } from "react";
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { iconChipFinish, iconChipRadius } from "@centraid/design";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { borders, family, metrics, radii, t, useTheme } from "../../kit/theme";
import type { Scheme, ThemeColors } from "../../kit/theme";
import type { LauncherItem } from "./catalog";
import { togglePlacePin, usePlacePins } from "./home-pins";
import {
  PLACE_COUNT,
  isPlacePinned,
  pinnedPlaces,
  searchPlaces,
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
  const { colors, scheme } = useTheme();
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
  const places = useMemo(() => searchPlaces(trimmed), [trimmed]);
  // The handoff's own foot formula (:5990-5991): pinned apps (Home excluded,
  // since it carries no switch) over the total installed, then pinned places
  // (Home included, since it counts as pinned by law) over all eleven.
  const footText = `${pinnedSet.size} of ${items.length} apps · ${
    pinnedPlaces(placePins).length
  } of ${PLACE_COUNT} places`;

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
            onSubmitEditing={() => Keyboard.dismiss()}
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
              scheme={scheme}
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
  scheme,
  colors,
  styles,
  pinned,
  onOpen,
  onTogglePin,
}: {
  item: LauncherItem;
  tile: TileData | undefined;
  scheme: Scheme;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  pinned: boolean;
  onOpen: () => void;
  onTogglePin: (pinned: boolean) => void;
}): React.JSX.Element {
  const { meta, installed } = item;
  const finish = iconChipFinish(meta.color, colors.bg, scheme);
  const count = countText(tile);
  const label = installed
    ? `Open ${meta.name}, ${count}`
    : `${meta.name}, on your desktop — tap to pair`;
  // Recede at the LEAF, never the container: an uninstalled entry's mark and
  // name step down to the theme's faint tokens directly, instead of wrapping
  // the row in an opacity-faded View. Container opacity composites every
  // descendant and silently invalidates token-level contrast.
  const recede = !installed;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onOpen}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View
        style={[
          styles.chip,
          {
            backgroundColor: recede ? colors.bgElev : finish.backgroundColor,
            borderRadius: iconChipRadius(ROW_ICON),
          },
        ]}
      >
        <Icon
          name={meta.iconKey}
          size={16}
          color={recede ? colors.textFaint : finish.markColor}
        />
      </View>
      {/* Pinned reads full-weight ink; unpinned is a lighter name — never a
          dimmed one. An uninstalled entry's recede state wins over both, since
          it cannot be pinned to a grid it has no tile on. */}
      <View style={styles.rowText}>
        <Text
          style={[
            styles.rowLabel,
            pinned && styles.rowLabelPinned,
            recede && styles.rowLabelRecede,
          ]}
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
        disabled={recede}
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
    >
      {/* A place owns no identity hue, so it takes a bare ink mark — the same
          rule the band follows for its own destinations, and always the
          faintest ink token (never the active-state colour a band tab uses,
          since nothing in this list is "current"). */}
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
      {/* Home has no switch to offer — it is in the launcher by law — rather
          than a switch that would only ever refuse (:3222-3239). */}
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
      borderRadius: 12,
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
    // Home has no switch: "by law" fills the same 34px-ish slot in the same
    // mono numeric register the counts use, so the row stays one shape whether
    // it ends in a switch or the reason there isn't one (:3226, :5479).
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
    rowLabelRecede: { ...t("small"), color: colors.textFaint },
    rowMeta: { ...t("mono"), color: colors.textFaint },
    rowPressed: { backgroundColor: colors.bgHover },
    rowText: { flex: 1 },
    scrim: { backgroundColor: colors.scrim, flex: 1 },
    // The same style serves both sub-heads (:5482-5485) — the border-top is
    // what separates one half of the sheet from the other, not a wrapping
    // container's own rule.
    sectionHead: {
      borderTopColor: colors.lineStrong,
      borderTopWidth: borders.hairline,
      color: colors.textFaint,
      fontFamily: family.sansRegular,
      fontSize: 11,
      letterSpacing: 0.7,
      marginTop: 8,
      paddingBottom: 4,
      paddingHorizontal: 20,
      paddingTop: 12,
      textTransform: "uppercase",
    },
    // Elevated ground + a hairline all round (:5976-5978) — the panel used to
    // sit on the page's own `colors.bg` with no border at all, which made it
    // read as part of the page rather than a surface floating over it.
    sheet: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderTopLeftRadius: 12,
      borderTopRightRadius: 12,
      borderWidth: borders.hairline,
      maxHeight: "80%",
    },
    title: {
      color: colors.text,
      flex: 1,
      fontFamily: family.sansMedium,
      fontSize: 15,
    },
  });
