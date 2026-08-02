import React, { useMemo } from "react";
import { Pressable, View, Text, StyleSheet } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

import type { IconName } from "@centraid/design";

import { radii, spacing, t, useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import Icon from "./Icon";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "quiet"
  | "destructive"
  | "destructiveFilled";

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
  const isPrimary = variant === "primary";
  const isQuiet = variant === "quiet";
  const isDestructive = variant === "destructive";
  const isDestructiveFilled = variant === "destructiveFilled";
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.base,
        isPrimary && styles.primary,
        variant === "secondary" && styles.secondary,
        isQuiet && styles.quiet,
        isDestructive && styles.destructive,
        isDestructiveFilled && styles.destructiveFilled,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
        style,
      ]}
    >
      <View style={styles.row}>
        {icon ? (
          <Icon
            name={icon}
            size={14}
            color={
              disabled
                ? colors.textDisabled
                : isPrimary || isDestructiveFilled
                  ? colors.textInv
                  : isDestructive
                    ? colors.danger
                    : colors.text
            }
            strokeWidth={isPrimary || isDestructiveFilled ? 2 : 1.75}
          />
        ) : null}
        <Text
          style={[
            styles.label,
            disabled && styles.labelDisabled,
            (isPrimary || isDestructiveFilled) && styles.labelPrimary,
            isDestructive && styles.labelDestructive,
          ]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    base: {
      borderRadius: radii.md,
      borderWidth: 1,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    disabled: { borderColor: colors.lineStrong },
    destructive: { backgroundColor: colors.bgElev, borderColor: colors.danger },
    destructiveFilled: {
      backgroundColor: colors.danger,
      borderColor: "transparent",
    },
    label: { ...t("control"), color: colors.text },
    labelDestructive: { color: colors.danger },
    labelDisabled: { color: colors.textDisabled },
    labelPrimary: { color: colors.textInv },
    pressed: { opacity: 0.85 },
    primary: { backgroundColor: colors.accentFill, borderColor: "transparent" },
    quiet: { backgroundColor: "transparent", borderColor: "transparent" },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      justifyContent: "center",
    },
    secondary: { backgroundColor: colors.bgElev, borderColor: colors.line },
  });
