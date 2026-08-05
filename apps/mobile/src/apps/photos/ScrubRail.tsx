// The scrub rail, phone form (Photos v4 handoff §4.5).
//
// Position in a list tens of thousands long. Not a scrollbar and not a slider:
// it is labelled by month.
//
// On the phone the rail OVERLAYS the grid — absolutely positioned on the
// trailing edge, 44px wide, not hit-testable except while the thumb is on it.
// A real 44px column would cost 11% of a 390px screen for a control the thumb
// only touches while dragging. The only visible part is the month bubble,
// which tracks the drag.

import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { borders, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

/** §4.5: the rail is 44px wide, matching the minimum target everywhere else. */
export const RAIL_WIDTH = 44;

export interface ScrubRailProps {
  /** The month the drag is currently over, e.g. `Aug 2026`. Empty = idle, and
   *  an idle rail shows nothing at all. */
  label: string;
  /** 0-1 down the rail, so the bubble sits beside the thumb. */
  position: number;
  onScrub: (ratio: number) => void;
  onScrubEnd: () => void;
  /** Where the rail starts and ends inside the content area. */
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
      // The rail is the drag surface; it claims touches only where the thumb
      // actually is, so the grid underneath stays tappable everywhere else.
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
      // 999 radius, paper, hairline — a label, not a control.
      borderRadius: 999,
      borderWidth: borders.hairline,
      // `insetInlineEnd` rather than `right`, so the bubble mirrors under RTL —
      // and never the legacy `end`, which types but does not lay out.
      insetInlineEnd: 8,
      paddingHorizontal: 10,
      paddingVertical: 4,
      position: "absolute",
    },
    bubbleText: { ...t("mono"), color: colors.text },
    rail: {
      // Trailing edge, in logical terms.
      insetInlineEnd: 0,
      position: "absolute",
      width: RAIL_WIDTH,
    },
  });
