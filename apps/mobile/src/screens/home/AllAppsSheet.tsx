// The "All apps" bottom sheet the band's More tab opens (issue #707 Phase 5).
// A searchable list of every app — Assistant included — as a 44px row with
// its icon, name, and a switch that pins/unpins it on the band. Unlike
// ./LauncherGrid's 4-up tiles (still used by the full-screen SearchOverlay),
// this is a single-column row list: a pin switch needs a trailing slot a grid
// tile has no room for, and the brief's own Tier-2 description ("a searchable
// sheet listing every installed app as a 44px row … and a switch that
// pins/unpins") is a row list, not a grid.
//
// Cross-platform Modal (not ActionSheetIOS): the search field and per-row
// switch need real layout, and the brief asks for identical iOS/Android
// behaviour beyond safe-area handling.

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

import { iconChipFinish, iconChipRadius } from "@centraid/design";

import Grabber from "../../kit/components/Grabber";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { metrics, t, useTheme } from "../../kit/theme";
import type { Scheme, ThemeColors } from "../../kit/theme";
import type { BandTab } from "./band";
import { MAX_PINS } from "./band";

const ROW_ICON = 28;

function matches(entry: BandTab, query: string): boolean {
  if (!query) return true;
  return entry.name.toLowerCase().includes(query.toLowerCase());
}

export interface AllAppsSheetProps {
  visible: boolean;
  entries: readonly BandTab[];
  pinnedIds: readonly string[];
  onOpen: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onClose: () => void;
}

export default function AllAppsSheet({
  visible,
  entries,
  pinnedIds,
  onOpen,
  onTogglePin,
  onClose,
}: AllAppsSheetProps): React.JSX.Element {
  const { colors, scheme } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const atCap = pinnedSet.size >= MAX_PINS;
  const trimmed = query.trim();
  const filtered = useMemo(
    () => entries.filter((entry) => matches(entry, trimmed)),
    [entries, trimmed]
  );

  return (
    <Modal
      transparent
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityLabel="Close all apps"
        style={styles.scrim}
        onPress={onClose}
      />
      <View
        style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}
      >
        <Grabber />
        <View style={styles.header}>
          <Text style={styles.title}>All apps</Text>
          <Text style={styles.subtitle}>
            {pinnedSet.size} of {MAX_PINS} pinned to the band
          </Text>
        </View>
        <View style={styles.field}>
          <Icon
            name="Search"
            size={16}
            color={colors.textFaint}
            strokeWidth={1.8}
          />
          <TextInput
            accessibilityLabel="Search all apps"
            value={query}
            onChangeText={setQuery}
            placeholder="Search apps"
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
          {filtered.map((entry) => (
            <AppRow
              key={entry.id}
              entry={entry}
              scheme={scheme}
              colors={colors}
              styles={styles}
              pinned={pinnedSet.has(entry.id)}
              pinDisabled={!pinnedSet.has(entry.id) && atCap}
              onOpen={() => {
                onClose();
                onOpen(entry.id);
              }}
              onTogglePin={(next) => onTogglePin(entry.id, next)}
            />
          ))}
          {filtered.length === 0 ? (
            <Text style={styles.empty}>
              No apps match &ldquo;{trimmed}&rdquo;.
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

function AppRow({
  entry,
  scheme,
  colors,
  styles,
  pinned,
  pinDisabled,
  onOpen,
  onTogglePin,
}: {
  entry: BandTab;
  scheme: Scheme;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  pinned: boolean;
  pinDisabled: boolean;
  onOpen: () => void;
  onTogglePin: (pinned: boolean) => void;
}): React.JSX.Element {
  const finish = entry.color
    ? iconChipFinish(entry.color, colors.bg, scheme)
    : undefined;
  const label = entry.installed
    ? `Open ${entry.name}`
    : `${entry.name}, on your desktop — tap to pair`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onOpen}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={!entry.installed && styles.dimmed}>
        {finish ? (
          <View
            style={[
              styles.chip,
              {
                backgroundColor: finish.backgroundColor,
                borderRadius: iconChipRadius(ROW_ICON),
              },
            ]}
          >
            <Icon
              name={entry.icon}
              size={16}
              color={finish.markColor}
              strokeWidth={1.8}
            />
          </View>
        ) : (
          <View style={styles.chip}>
            <Icon
              name={entry.icon}
              size={18}
              color={colors.textSoft}
              strokeWidth={1.7}
            />
          </View>
        )}
      </View>
      <Text style={styles.rowLabel} numberOfLines={1}>
        {entry.name}
      </Text>
      <Switch
        value={pinned}
        disabled={pinDisabled}
        onValueChange={onTogglePin}
        trackColor={{ false: colors.lineStrong, true: colors.text }}
        thumbColor={colors.bg}
        accessibilityLabel={`${pinned ? "Unpin" : "Pin"} ${entry.name} on the band`}
      />
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
    dimmed: { opacity: 0.45 },
    empty: { ...t("small"), color: colors.textSoft, paddingVertical: 20 },
    field: {
      alignItems: "center",
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 8,
      height: 44,
      marginHorizontal: 20,
      marginTop: 4,
      paddingHorizontal: 12,
    },
    header: { marginBottom: 4, paddingHorizontal: 20 },
    input: { ...t("body"), color: colors.text, flex: 1, padding: 0 },
    list: { marginTop: 8, maxHeight: 440 },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      minHeight: metrics.row,
      paddingHorizontal: 20,
    },
    rowLabel: { ...t("body"), color: colors.text, flex: 1 },
    rowPressed: { backgroundColor: colors.bgHover },
    scrim: { backgroundColor: colors.scrim, flex: 1 },
    sheet: {
      backgroundColor: colors.bg,
      borderTopLeftRadius: 12,
      borderTopRightRadius: 12,
      maxHeight: "80%",
    },
    subtitle: { ...t("small"), color: colors.textFaint },
    title: { ...t("display"), color: colors.text, marginBottom: 2 },
  });
