/**
 * The grant sheet's revoke confirm (#825). One question, two outlined
 * actions: Keep sharing, or ask their vault to remove its copy.
 */
import React from "react";
import { Pressable, View } from "react-native";

import {
  REVOKE_CANCEL_ACTION,
  REVOKE_CONFIRM_ACTION,
  revokeConfirmBody,
  revokeConfirmTitle,
} from "@centraid/blueprints/apps/_shared/grant-copy";

import { Text } from "../components/NativeText";
import type { ThemeColors } from "../theme";
import { styles } from "./GrantSheet.styles";

export function GrantSheetConfirm(props: {
  audienceLabel: string;
  subjectNoun: string;
  busy: boolean;
  colors: ThemeColors;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const { audienceLabel, subjectNoun, busy, colors, onCancel, onConfirm } =
    props;
  return (
    <View style={styles.section}>
      <Text style={[styles.title, { color: colors.text }]}>
        {revokeConfirmTitle(audienceLabel)}
      </Text>
      <Text style={[styles.reading, { color: colors.text }]}>
        {revokeConfirmBody(audienceLabel, subjectNoun)}
      </Text>
      <View style={styles.confirmRow}>
        <Pressable
          accessibilityRole="button"
          onPress={onCancel}
          style={[styles.pill, { borderColor: colors.line }]}
        >
          <Text style={{ color: colors.text }}>{REVOKE_CANCEL_ACTION}</Text>
        </Pressable>
        {/* Destructive is OUTLINED in `--net`, never a fill. */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onConfirm}
          style={[styles.pill, { borderColor: colors.net }]}
        >
          <Text style={{ color: colors.net }}>{REVOKE_CONFIRM_ACTION}</Text>
        </Pressable>
      </View>
    </View>
  );
}
