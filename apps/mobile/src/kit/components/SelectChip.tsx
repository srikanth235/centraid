import React, { useMemo } from "react";
import { Pressable, StyleSheet } from "react-native";

import { t, useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import { Text } from "./NativeText";

/** A compact, explicit entry into multi-select mode. */
export default function SelectChip({
  disabled,
  onPress,
}: {
  disabled: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Select"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={styles.chip}
    >
      <Text style={styles.text}>Select</Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    chip: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      paddingHorizontal: 8,
    },
    text: { ...t("control"), color: colors.text },
  });
