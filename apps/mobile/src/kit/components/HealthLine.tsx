import React, { useMemo } from "react";
import { Pressable, View } from "react-native";

import { useTheme } from "../theme";
import { styles } from "./HealthLine.styles";
import { Text } from "./NativeText";

export type HealthTone = "neutral" | "seam";

export interface HealthLineProps {
  text: string;
  action?: string;
  onAction?: () => void;
  tone?: HealthTone;
  accessibilityLabel?: string;
}

export default function HealthLine({
  text,
  action,
  onAction,
  tone = "neutral",
  accessibilityLabel,
}: HealthLineProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(
    () => ({
      action: { color: colors.text },
      dot: {
        backgroundColor: tone === "seam" ? colors.seam : colors.textFaint,
      },
      row: { backgroundColor: colors.bg, borderTopColor: colors.line },
      text: { color: colors.textFaint },
    }),
    [colors, tone]
  );
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityLiveRegion="polite"
      accessibilityRole="text"
      style={[styles.row, ink.row]}
    >
      <View style={[styles.dot, ink.dot]} />
      <Text
        ellipsizeMode="tail"
        numberOfLines={1}
        style={[styles.text, ink.text]}
      >
        {text}
      </Text>
      {action && onAction ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          style={styles.action}
        >
          <Text style={[styles.actionText, ink.action]}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
