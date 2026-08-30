// The phone's bottom band (§3.1). Opaque paper, never glass: contrast must not
// depend on what was photographed. Content ends ABOVE the band by LAYOUT, never
// by padding on the scroll content.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
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
import { TEST_IDS, TEST_ID_PREFIXES } from "../../kit/test-ids";
import { t, useTheme, radii } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { resolveBand } from "./photos-band";
import type { BandDestinationKey } from "./photos-band";

const GROUP_GUTTER = 2;
const PLATE_GAP = 8;
const ACTIVE_RULE = 2;
const ACTIVE_RULE_INSET = 14;

export interface PhotosBandProps {
  owner: BandOwner;
  current: BandDestinationKey;
  onSelect: (key: BandDestinationKey) => void;
  onHome: () => void;
}

export default function PhotosBand({
  owner,
  current,
  onSelect,
  onHome,
}: PhotosBandProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const band = resolveBand(owner);
  if (band.owner !== "app") {
    // HANDED BACK, BUT NOT STRANDED (#712): never `return null` — a Photos stack
    // screen has no frame band underneath, so the capsule stays.
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
    // No `accessibilityRole` here: a tablist would nest the capsule in the group.
    <View
      style={[styles.band, { paddingBottom: BAND_INSET + insets.bottom }]}
      testID={TEST_IDS.photos.band}
    >
      {/* A FRAME control on the frame's page colour, never Photos' mat. */}
      <BandCapsuleControl capsule={capsule} onPress={onHome} />

      {/* ONE group; the gap between the plates is the seam. */}
      <View style={styles.group} accessibilityRole="tablist">
        {band.destinations.map((destination) => {
          const active = destination.key === current;
          return (
            <Pressable
              key={destination.key}
              accessibilityRole="tab"
              accessibilityLabel={destination.label}
              // The DESTINATION KEY, never the label: the label is copy a v-next
              // handoff may re-word, and a flow that tapped it would then tap
              // nothing while still reporting COMPLETED (#890 W2).
              testID={`${TEST_ID_PREFIXES.band.photos}${destination.key}`}
              accessibilityState={{ selected: active }}
              onPress={() => onSelect(destination.key)}
              style={styles.tab}
            >
              {/* A mark on the leaf, never a container opacity. */}
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
      height: ACTIVE_RULE,
      insetInlineEnd: ACTIVE_RULE_INSET,
      insetInlineStart: ACTIVE_RULE_INSET,
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
      // No `fontFamily` override: `t("control")` is sansMedium. Active state
      // is colour plus the ink rule, never weight.
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
