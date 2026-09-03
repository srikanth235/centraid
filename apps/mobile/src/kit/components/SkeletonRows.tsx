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

type BoneWidth = `${number}%`;

export interface SkeletonRowsProps {
  rows?: number;
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
