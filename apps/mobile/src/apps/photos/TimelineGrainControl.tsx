import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  BAND_ACTIVE_RULE,
  BAND_ACTIVE_RULE_INSET,
  BAND_BORDER,
  BAND_INSET,
  BAND_RADIUS,
} from "../../kit/band-surface";
import { Text } from "../../kit/components/NativeText";
import { t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { GRAIN_LABELS, TIMELINE_GRAINS } from "./timeline-grains";
import type { TimelineGrain } from "./timeline-grains";

const SEGMENT_MIN_HEIGHT = 44;

export const GRAIN_CONTROL_SLOT =
  SEGMENT_MIN_HEIGHT + 2 * BAND_BORDER + BAND_INSET;

export interface TimelineGrainControlProps {
  grain: TimelineGrain;
  onGrain: (grain: TimelineGrain) => void;
}

export default function TimelineGrainControl({
  grain,
  onGrain,
}: TimelineGrainControlProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <View style={styles.dock}>
      <View style={styles.plate} accessibilityRole="tablist">
        {TIMELINE_GRAINS.map((key) => {
          const active = key === grain;
          return (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityLabel={GRAIN_LABELS[key]}
              accessibilityState={{ selected: active }}
              onPress={() => onGrain(key)}
              style={styles.segment}
            >
              <View
                style={[
                  styles.activeRule,
                  active ? { backgroundColor: colors.text } : styles.ruleHidden,
                ]}
              />
              <Text
                numberOfLines={1}
                style={[styles.label, active ? styles.labelActive : undefined]}
              >
                {GRAIN_LABELS[key]}
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
      height: BAND_ACTIVE_RULE,
      insetInlineEnd: BAND_ACTIVE_RULE_INSET,
      insetInlineStart: BAND_ACTIVE_RULE_INSET,
      position: "absolute",
      top: 0,
    },
    dock: {
      alignItems: "center",
      bottom: 0,
      insetInlineEnd: 0,
      insetInlineStart: 0,
      paddingBottom: BAND_INSET,
      pointerEvents: "box-none",
      position: "absolute",
      zIndex: 2,
    },
    label: { ...t("control"), color: colors.textSoft },
    labelActive: { color: colors.text },
    plate: {
      backgroundColor: colors.bgElev,
      borderColor: colors.lineStrong,
      borderRadius: BAND_RADIUS,
      borderWidth: BAND_BORDER,
      flexDirection: "row",
      gap: 2,
      overflow: "hidden",
      paddingHorizontal: 2,
    },
    ruleHidden: { backgroundColor: "transparent" },
    segment: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: SEGMENT_MIN_HEIGHT,
      paddingHorizontal: 18,
    },
  });
