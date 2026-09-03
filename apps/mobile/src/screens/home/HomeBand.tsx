import * as Haptics from "expo-haptics";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  BAND_BORDER,
  BAND_INSET,
  bandSurfaceStyle,
} from "../../kit/band-surface";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { TEST_IDS, TEST_ID_PREFIXES } from "../../kit/test-ids";
import { borders, family, metrics, t, useTheme, radii } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { bandTabs } from "./band";
import type { BandTab, BandTarget } from "./band";
import { usePlacePins } from "./home-pins";
import { enabledPlacePins } from "./places";

export interface HomeBandProps {
  active: BandTarget;
  onSelect: (target: BandTarget) => void;
}

export default function HomeBand({
  active,
  onSelect,
}: HomeBandProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const pins = usePlacePins();
  const { features } = useReplica();
  const tabs = useMemo(
    () => bandTabs(enabledPlacePins(pins, features)),
    [pins, features]
  );

  return (
    <View
      style={[styles.wrap, { marginBottom: BAND_INSET + insets.bottom }]}
      testID={TEST_IDS.home.band}
    >
      {tabs.map((tab) => (
        <Tab
          key={tab.id}
          tab={tab}
          active={tab.id === active}
          colors={colors}
          styles={styles}
          onPress={() => {
            void Haptics.selectionAsync();
            onSelect(tab.id);
          }}
        />
      ))}
      {/* More is not a place — "···" in a bordered square, outside the loop. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="All apps and places"
        onPress={() => {
          void Haptics.selectionAsync();
          onSelect("more");
        }}
        style={({ pressed }) => [styles.tab, pressed && styles.tabPressed]}
        testID={TEST_IDS.home.bandMore}
      >
        <View style={styles.moreGlyph}>
          <Text style={styles.moreGlyphMark}>···</Text>
        </View>
        <Text style={styles.moreLabel} numberOfLines={1}>
          More
        </Text>
      </Pressable>
    </View>
  );
}

function Tab({
  tab,
  active,
  colors,
  styles,
  onPress,
}: {
  tab: BandTab;
  active: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tab.name + (active ? ", current place" : "")}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.tab, pressed && styles.tabPressed]}
      testID={`${TEST_ID_PREFIXES.band.home}${tab.id}`}
    >
      <View style={styles.mark}>
        {/* Inactive is `textFaint`, never the label's token, never an app hue. */}
        <Icon
          name={tab.icon}
          size={19}
          color={active ? colors.text : colors.textFaint}
        />
      </View>
      {/* Selection is the label's weight and colour only. */}
      <Text
        style={[styles.label, active ? styles.labelActive : undefined]}
        numberOfLines={1}
      >
        {tab.short}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    label: {
      ...t("band"),
      alignSelf: "stretch",
      color: colors.textSoft,
      marginTop: 3,
      textAlign: "center",
    },
    labelActive: { ...t("control"), color: colors.text },
    mark: {
      alignItems: "center",
      borderRadius: radii.md,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    moreGlyph: {
      alignItems: "center",
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      height: 26,
      justifyContent: "center",
      width: 26,
    },
    moreGlyphMark: {
      color: colors.textSoft,
      fontFamily: family.sansMedium,
      fontSize: t("mono").fontSize,
    },
    moreLabel: {
      ...t("band"),
      alignSelf: "stretch",
      color: colors.textSoft,
      marginTop: 3,
      textAlign: "center",
    },
    tab: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      minHeight: metrics.row,
      overflow: "hidden",
      paddingBottom: 3,
      paddingHorizontal: 4,
      paddingTop: 7,
    },
    tabPressed: { backgroundColor: colors.bgPress },
    wrap: {
      flexDirection: "row",
      paddingHorizontal: 4,
      ...bandSurfaceStyle(colors.bgElev, colors.lineStrong, BAND_BORDER),
    },
  });
