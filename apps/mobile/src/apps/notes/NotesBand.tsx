// The band Notes has claimed, rendered (#882).
//
// Two plates in a transparent row — the frame's Home capsule on the frame's
// neutral page colour, then the app's five destinations as one group on
// `bgElev` — the same anatomy `TasksBand.tsx` and `DocsBand.tsx` draw, from
// the shared plate geometry in `kit/band-surface.ts`. This file renders
// `notes-band.ts` and adds nothing.
//
// When the member has handed the band back (`owner === "host"`) the tab group
// goes and the capsule STAYS — the way home is the one thing an app may never
// take away.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  BAND_ACTIVE_RULE,
  BAND_ACTIVE_RULE_INSET,
  BAND_BORDER,
  BAND_HEIGHT,
  BAND_INSET,
  BAND_RADIUS,
  BAND_TAB_MIN_HEIGHT,
  BAND_TOP_GAP,
} from "../../kit/band-surface";
import type { BandOwner } from "../../kit/band/band-owner";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { NOTES_BAND_CAPSULE, resolveNotesBand } from "./notes-band";
import type { NotesBandDestinationKey } from "./notes-band";

/** The group plate's inner gutter and the gap between the two plates. */
const GROUP_GUTTER = 2;
const PLATE_GAP = 8;

export interface NotesBandProps {
  owner: BandOwner;
  current: NotesBandDestinationKey;
  onSelect: (key: NotesBandDestinationKey) => void;
  /** The capsule's one tap: all apps and places, in one move. */
  onHome: () => void;
}

export default function NotesBand({
  owner,
  current,
  onSelect,
  onHome,
}: NotesBandProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const band = resolveNotesBand(owner);

  if (band.owner !== "app") {
    return (
      <View
        style={[styles.band, { paddingBottom: BAND_INSET + insets.bottom }]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={NOTES_BAND_CAPSULE.label}
          onPress={onHome}
          style={[styles.capsule, { width: NOTES_BAND_CAPSULE.size }]}
        >
          <Icon
            name={NOTES_BAND_CAPSULE.icon}
            size={19}
            color={colors.textSoft}
          />
        </Pressable>
      </View>
    );
  }

  const { capsule } = band;
  return (
    <View style={[styles.band, { paddingBottom: BAND_INSET + insets.bottom }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={capsule.label}
        onPress={onHome}
        style={[styles.capsule, { width: capsule.size }]}
      >
        <Icon name={capsule.icon} size={19} color={colors.textSoft} />
      </Pressable>

      <View style={styles.group} accessibilityRole="tablist">
        {band.destinations.map((destination) => {
          const active = destination.key === current;
          return (
            <Pressable
              key={destination.key}
              accessibilityRole="tab"
              accessibilityLabel={destination.label}
              accessibilityState={{ selected: active }}
              onPress={() => onSelect(destination.key)}
              style={styles.tab}
            >
              <View
                style={[
                  styles.activeRule,
                  active ? { backgroundColor: colors.text } : styles.ruleHidden,
                ]}
              />
              <Icon
                name={destination.icon}
                size={20}
                color={active ? colors.text : colors.textSoft}
              />
              <Text
                numberOfLines={1}
                style={[styles.label, active ? styles.labelActive : undefined]}
              >
                {destination.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    activeRule: {
      borderRadius: radii.xs,
      height: BAND_ACTIVE_RULE,
      insetInlineEnd: BAND_ACTIVE_RULE_INSET,
      insetInlineStart: BAND_ACTIVE_RULE_INSET,
      position: "absolute",
      top: 0,
    },
    band: {
      alignItems: "stretch",
      backgroundColor: "transparent",
      flexDirection: "row",
      gap: PLATE_GAP,
      minHeight: BAND_HEIGHT,
      paddingHorizontal: BAND_INSET,
      paddingTop: BAND_TOP_GAP,
    },
    capsule: {
      alignItems: "center",
      backgroundColor: colors.bg,
      borderColor: colors.lineStrong,
      borderRadius: BAND_RADIUS,
      borderWidth: BAND_BORDER,
      justifyContent: "center",
    },
    group: {
      alignItems: "stretch",
      backgroundColor: colors.bgElev,
      borderColor: colors.lineStrong,
      borderRadius: BAND_RADIUS,
      borderWidth: BAND_BORDER,
      flex: 1,
      flexDirection: "row",
      gap: GROUP_GUTTER,
      paddingHorizontal: GROUP_GUTTER,
    },
    label: {
      ...t("control"),
      alignSelf: "stretch",
      color: colors.textSoft,
      textAlign: "center",
    },
    labelActive: { color: colors.text },
    ruleHidden: { backgroundColor: "transparent" },
    tab: {
      alignItems: "center",
      flex: 1,
      gap: GROUP_GUTTER,
      justifyContent: "center",
      minHeight: BAND_TAB_MIN_HEIGHT,
      minWidth: 0,
    },
  });
