// The band Tasks has claimed, rendered (Tasks spec §2; #834).
//
// Anatomy and shared plate geometry: `PhotosBand.tsx` and
// `kit/band-surface.ts`. This file renders `tasks-band.ts` and adds nothing.
//
// SIZED TO CONTENT WITH A 44px FLOOR, not six equal cells: all five labels
// render in full at 390px because each tab takes the width its word needs.
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
import BandCapsuleControl from "../../kit/band/BandCapsule";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { resolveTasksBand } from "./tasks-band";
import type { TasksBandDestinationKey } from "./tasks-band";

/** The group plate's inner gutter and the gap between the two plates. */
const GROUP_GUTTER = 2;
const PLATE_GAP = 8;

export interface TasksBandProps {
  owner: BandOwner;
  current: TasksBandDestinationKey;
  onSelect: (key: TasksBandDestinationKey) => void;
  /** The capsule's one tap: all apps and places, in one move. */
  onHome: () => void;
}

export default function TasksBand({
  owner,
  current,
  onSelect,
  onHome,
}: TasksBandProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const band = resolveTasksBand(owner);

  if (band.owner !== "app") {
    return (
      <View
        style={[styles.band, { paddingBottom: BAND_INSET + insets.bottom }]}
      >
        <BandCapsuleControl onPress={onHome} />
      </View>
    );
  }

  const { capsule } = band;
  return (
    <View style={[styles.band, { paddingBottom: BAND_INSET + insets.bottom }]}>
      <BandCapsuleControl capsule={capsule} onPress={onHome} />

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
