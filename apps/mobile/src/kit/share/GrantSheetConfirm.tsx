import React from "react";
import { Pressable, View } from "react-native";

import { Text } from "../components/NativeText";
import type { ThemeColors } from "../theme";
import { styles } from "./GrantSheet.styles";

export function GrantSheetConfirm(props: {
  title: string;
  body: string;
  cancelLabel: string;
  confirmLabel: string;
  destructive?: boolean;
  busy: boolean;
  colors: ThemeColors;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const { busy, colors, onCancel, onConfirm } = props;
  const confirmColor = props.destructive === true ? colors.net : colors.accent;
  return (
    <View style={styles.section}>
      <Text style={[styles.title, { color: colors.text }]}>{props.title}</Text>
      <Text style={[styles.reading, { color: colors.text }]}>{props.body}</Text>
      <View style={styles.confirmRow}>
        <Pressable
          accessibilityRole="button"
          onPress={onCancel}
          style={[styles.pill, { borderColor: colors.line }]}
        >
          <Text style={{ color: colors.text }}>{props.cancelLabel}</Text>
        </Pressable>
        {/* Destructive is OUTLINED in `--net`, never a fill. */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onConfirm}
          style={[styles.pill, { borderColor: confirmColor }]}
        >
          <Text style={{ color: confirmColor }}>{props.confirmLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}
