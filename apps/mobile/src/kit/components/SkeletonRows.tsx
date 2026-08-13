// SKELETON — the loading state, at the geometry of the thing that is loading
// (#765, spec §10).
//
// Never a spinner. A spinner says "I don't know how long", which on a gateway
// running on the member's own machine is almost never true, and it says
// nothing at all about what is arriving. A skeleton at the row block's exact
// geometry says both: this is a list, of rows this tall, and nothing will
// reflow when the words land.
//
// The breath is one `Animated.Value` per row on the native driver, staggered
// 90ms down the list, and it is GATED by the app's existing reduced-motion
// hook — when a member has asked for less motion the rows are pinned at the
// rest opacity rather than animated to a shorter duration, because a 1ms
// breath is a flicker, which is the thing the setting exists to prevent.

import React, { useEffect, useMemo } from "react";
import { Animated, View } from "react-native";

import {
  boneDelay,
  boneWidths,
  SKELETON_PULSE_HIGH,
  SKELETON_PULSE_LOW,
  SKELETON_PULSE_MS,
  SKELETON_ROWS,
} from "@centraid/design/blocks";

import { useAnimatedValue } from "../hooks/useAnimatedValue";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useTheme } from "../theme";
import { styles } from "./SkeletonRows.styles";

/** A bone's width, in the one form a native style accepts. The shared model
 *  counts in shares of the row; this is the unit that share is drawn in. */
type BoneWidth = `${number}%`;

export interface SkeletonRowsProps {
  /** How many rows. Six is the reference's own count. */
  rows?: number;
  /** What is being read, in one sentence — the only thing a screen reader
   *  can be told about a surface that has no content yet. */
  accessibilityLabel: string;
}

function SkeletonRow({
  width,
  delay,
  first,
  reduced,
  boneColor,
  lineColor,
}: {
  width: BoneWidth;
  delay: number;
  first: boolean;
  reduced: boolean;
  boneColor: string;
  lineColor: string;
}): React.JSX.Element {
  const opacity = useAnimatedValue(SKELETON_PULSE_HIGH);
  useEffect(() => {
    if (reduced) {
      opacity.setValue(SKELETON_PULSE_HIGH);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(opacity, {
          duration: SKELETON_PULSE_MS / 2,
          toValue: SKELETON_PULSE_LOW,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          duration: SKELETON_PULSE_MS / 2,
          toValue: SKELETON_PULSE_HIGH,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [delay, opacity, reduced]);

  return (
    <View
      style={[
        styles.row,
        { borderTopColor: lineColor },
        first ? styles.rowFirst : undefined,
      ]}
    >
      <Animated.View
        style={[styles.bone, { backgroundColor: boneColor, opacity, width }]}
      />
    </View>
  );
}

export default function SkeletonRows({
  rows = SKELETON_ROWS,
  accessibilityLabel,
}: SkeletonRowsProps): React.JSX.Element {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const widths = useMemo(
    () => boneWidths(rows).map((share): BoneWidth => `${share}%`),
    [rows]
  );
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="progressbar"
      accessibilityState={{ busy: true }}
      style={[
        styles.block,
        { backgroundColor: colors.bgElev, borderColor: colors.line },
      ]}
    >
      {widths.map((width, index) => (
        <SkeletonRow
          boneColor={colors.skel}
          delay={boneDelay(index)}
          first={index === 0}
          key={`bone-${String(index)}`}
          lineColor={colors.line}
          reduced={reduced}
          width={width}
        />
      ))}
    </View>
  );
}
