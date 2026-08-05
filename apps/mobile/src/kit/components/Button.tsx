import React, { useMemo } from "react";
import { Pressable, View, StyleSheet } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

import { nativeButtonStyle } from "@centraid/design";
import type {
  ButtonVariant,
  IconName,
  NativeButtonStyle,
} from "@centraid/design";

import { spacing, t, useTheme } from "../theme";
import Icon from "./Icon";
import { Text } from "./NativeText";

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export default function Button({
  label,
  onPress,
  variant = "secondary",
  icon,
  disabled,
  style,
}: ButtonProps): React.JSX.Element {
  const { colors, radii, targetMin } = useTheme();
  const recipeStyle = useMemo(
    () => nativeButtonStyle(variant, { colors, radii, targetMin }, disabled),
    [colors, radii, targetMin, variant, disabled]
  );
  const styles = useMemo(() => makeStyles(recipeStyle), [recipeStyle]);
  // The recipe's visual box is the 34pt control height; hitSlop restores the
  // 48pt coarse touch target around it without inflating what's drawn.
  const verticalHitSlop = (targetMin.coarse - recipeStyle.minHeight) / 2;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      hitSlop={{
        bottom: verticalHitSlop,
        left: 0,
        right: 0,
        top: verticalHitSlop,
      }}
      onPress={disabled ? undefined : onPress}
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
