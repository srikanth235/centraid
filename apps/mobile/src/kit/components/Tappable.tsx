import React from "react";
import { Pressable } from "react-native";
import type { AccessibilityRole, StyleProp, ViewStyle } from "react-native";

const PRESSED_OPACITY = 0.85;

const TARGET_SLOP = 10;

export interface TappableProps {
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  accessibilityRole?: AccessibilityRole;
  disabled?: boolean;
  hitSlop?: number;
  onPressIn?: () => void;
  onPressOut?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children?: React.ReactNode;
}

export default function Tappable({
  onPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = "button",
  disabled,
  hitSlop = TARGET_SLOP,
  onPressIn,
  onPressOut,
  style,
  testID,
  children,
}: TappableProps): React.JSX.Element {
  const ownPressTreatment = onPressIn !== undefined || onPressOut !== undefined;
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ disabled: disabled ?? false }}
      disabled={disabled ?? false}
      hitSlop={hitSlop}
      onPress={disabled ? undefined : onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      testID={testID}
      style={({ pressed }) => [
        style,
        pressed && !disabled && !ownPressTreatment
          ? { opacity: PRESSED_OPACITY }
          : null,
      ]}
    >
      {children}
    </Pressable>
  );
}
