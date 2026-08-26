// Phone scrub rail (Photos v4 §4.5): month-labelled, overlays the grid's
// trailing edge, 44px wide, hit-testable only under the thumb.

import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { borders, t, useTheme, radii } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export const RAIL_WIDTH = 44;

export interface ScrubRailProps {
  /** Month under the drag; empty = idle. */
  label: string;
  position: number;
  onScrub: (ratio: number) => void;
  onScrubEnd: () => void;
  top: number;
  bottom: number;
}

export default function ScrubRail({
  label,
  position,
  onScrub,
  onScrubEnd,
  top,
  bottom,
}: ScrubRailProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const height = Math.max(1, bottom - top);

  const ratioAt = (y: number): number => Math.max(0, Math.min(1, y / height));

  return (
    <View
      accessibilityLabel="Scrub the timeline by month"
      accessibilityRole="adjustable"
      // Claims touches only under the thumb; grid stays tappable.
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(event) =>
        onScrub(ratioAt(event.nativeEvent.locationY))
      }
      onResponderMove={(event) => onScrub(ratioAt(event.nativeEvent.locationY))}
      onResponderRelease={onScrubEnd}
      onResponderTerminate={onScrubEnd}
      style={[styles.rail, { bottom, top }]}
    >
      {label ? (
        <View
          style={[
            styles.bubble,
            { top: Math.max(0, Math.min(1, position)) * height },
          ]}
          pointerEvents="none"
        >
          <Text style={styles.bubbleText} numberOfLines={1}>
            {label}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    bubble: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.pill,
      borderWidth: borders.hairline,
      // `insetInlineEnd` mirrors under RTL; legacy `end` types but won't lay out.
      insetInlineEnd: 8,
      paddingHorizontal: 10,
      paddingVertical: 4,
      position: "absolute",
    },
    bubbleText: { ...t("mono"), color: colors.text },
    rail: {
      insetInlineEnd: 0,
      position: "absolute",
      width: RAIL_WIDTH,
    },
  });
