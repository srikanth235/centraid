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
import type { ThemeColors } from "../theme";
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
  const isPrimary = variant === "primary";
  const isDestructive = variant === "destructive";
  const { colors, radii, targetMin } = useTheme();
  const styles = useMemo(() => {
    const recipeStyle = nativeButtonStyle(variant, {
      colors,
      radii,
      targetMin,
    });
    return makeStyles(colors, recipeStyle);
  }, [colors, radii, targetMin, variant]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      hitSlop={{ bottom: 4, left: 4, right: 4, top: 4 }}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.base,
        styles.variant,
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
                : isPrimary
                  ? colors.textInv
                  : isDestructive
                    ? colors.danger
                    : colors.text
            }
          />
        ) : null}
        <Text
          style={[
            styles.label,
            isPrimary && styles.labelPrimary,
            isDestructive && styles.labelDestructive,
            disabled && styles.labelDisabled,
          ]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors, recipeStyle: NativeButtonStyle) =>
  StyleSheet.create({
    base: {
      borderRadius: recipeStyle.borderRadius,
      borderWidth: 1,
      minHeight: recipeStyle.minHeight,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    // Disabled recedes on the leaves — the icon and the label each take
    // `textDisabled` above. Fading the Pressable instead would composite every
    // descendant and quietly invalidate the contrast those tokens guarantee.
    disabled: { borderColor: colors.lineStrong },
    label: { ...t("smallStrong"), color: recipeStyle.color },
    labelDestructive: { color: recipeStyle.color },
    labelDisabled: { color: colors.textDisabled },
    labelPrimary: { color: colors.textInv },
    pressed: { opacity: 0.85 },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      justifyContent: "center",
    },
    variant: {
      backgroundColor: recipeStyle.backgroundColor,
      borderColor: recipeStyle.borderColor,
    },
  });
