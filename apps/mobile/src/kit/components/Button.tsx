import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

import { nativeButtonStyle } from "@centraid/design";
import type { ButtonVariant, NativeButtonStyle } from "@centraid/design";
import type { ButtonData } from "@centraid/design/blocks";

import { spacing, t, useTheme } from "../theme";
import Icon from "./Icon";
import { Text } from "./NativeText";

export interface ButtonProps extends ButtonData {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
  testID?: string;
}

export default function Button({
  label,
  onPress,
  variant = "secondary",
  icon,
  disabled,
  style,
  accessibilityHint,
  testID,
}: ButtonProps): React.JSX.Element {
  const { colors, radii, targetMin } = useTheme();
  const recipeStyle = useMemo(
    () => nativeButtonStyle(variant, { colors, radii, targetMin }, disabled),
    [colors, radii, targetMin, variant, disabled]
  );
  const styles = useMemo(() => makeStyles(recipeStyle), [recipeStyle]);
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onPress={disabled ? undefined : onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        pressed && !disabled && styles.pressed,
        style,
      ]}
    >
      <View style={styles.row}>
        {icon ? <Icon name={icon} size={14} color={recipeStyle.color} /> : null}
        <Text style={styles.label}>{label}</Text>
      </View>
    </Pressable>
  );
}

const makeStyles = (recipeStyle: NativeButtonStyle) =>
  StyleSheet.create({
    base: {
      backgroundColor: recipeStyle.backgroundColor,
      borderColor: recipeStyle.borderColor,
      borderRadius: recipeStyle.borderRadius,
      borderWidth: 1,
      minHeight: recipeStyle.minHeight,
      paddingHorizontal: recipeStyle.paddingHorizontal,
    },
    label: { ...t("smallStrong"), color: recipeStyle.color },
    pressed: { opacity: 0.85 },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      justifyContent: "center",
    },
  });
