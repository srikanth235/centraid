import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { borders, useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import Icon from "./Icon";

// Shared app-exit: ink GRID on a plate = leave to the springboard. Never a
// house (ambiguous as app-home vs launcher). Up-one-level stays the caller's
// chevron. Opaque paper plate — no blur/tint/shadow/teal: glass would float
// over the page and glyph contrast would depend on whatever sits underneath.
//
// Caller owns dismissal. `floating`: bottom-centered, `box-none` wrap so taps
// beside the plate fall through. `leave`: leading header control.

const FLOAT_SIZE = 54;
const HEADER_SIZE = 40;
const PLATE_RADIUS = 12;

export interface HomeKeyProps {
  onPress: () => void;
  variant: "floating" | "leave";
}

export default function HomeKey({
  onPress,
  variant,
}: HomeKeyProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => makeStyles(colors), [colors]);

  if (variant === "leave") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to your apps"
        onPress={onPress}
        style={[styles.plate, styles.headerKey]}
      >
        <Icon name="Grid" size={19} color={colors.text} />
      </Pressable>
    );
  }

  return (
    <View
      style={[styles.floatWrap, { paddingBottom: Math.max(insets.bottom, 10) }]}
      pointerEvents="box-none"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to your apps"
        onPress={onPress}
        style={[styles.plate, styles.floatKey]}
      >
        <Icon name="Grid" size={22} color={colors.text} />
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    floatKey: {
      height: FLOAT_SIZE,
      width: FLOAT_SIZE,
    },
    floatWrap: {
      alignItems: "center",
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
    },
    headerKey: {
      height: HEADER_SIZE,
      width: HEADER_SIZE,
    },
    // Opaque paper, hairline, 12px. Anything else is glass creeping back.
    plate: {
      alignItems: "center",
      backgroundColor: colors.bg,
      borderColor: colors.lineStrong,
      borderRadius: PLATE_RADIUS,
      borderWidth: borders.hairline,
      justifyContent: "center",
      overflow: "hidden",
    },
  });
