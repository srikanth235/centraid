// People's claimed bottom band, rendered (Binding Layer v12 handoff, § Nav).
//
// Anatomy and every shared value: `PhotosBand.tsx` and `kit/band-surface.ts`,
// so the claimed bands cannot drift apart.
//
// Mobile band tab: icon over label, 2px active rule pinned to the tab's top
// edge inset 14, `min-width: 44` via `flex:1` fifths of the plate. The active
// tab takes ink; selection is the rule + the colour, never a weight flip.

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
import { resolvePeopleBand } from "./people-band";
import type { PeopleBandKey } from "./people-band";

/** The group plate's inner gutter and the gap between the two plates — the
 *  same two numbers Photos' band draws (`:4955-4960`). */
const GROUP_GUTTER = 2;
const PLATE_GAP = 8;

export interface PeopleBandProps {
  owner: BandOwner;
  current: PeopleBandKey;
  onSelect: (key: PeopleBandKey) => void;
  /** The capsule's one tap: the frame's Home, in one move. */
  onHome: () => void;
}

export default function PeopleBand({
  owner,
  current,
  onSelect,
  onHome,
}: PeopleBandProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const band = resolvePeopleBand(owner);
  if (band.owner !== "app") {
    // Handed back, but never stranded: the tab group is what the member handed
    // back, not the frame's way out — the capsule stays (#712).
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
      {/* Plate one: the frame's capsule, on the frame's page colour. */}
      <BandCapsuleControl capsule={capsule} onPress={onHome} />

      {/* Plate two: the app's three destinations, one group on `bgElev`. */}
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
