// THE MODAL CONFIRM (v12 handoff § The three confirms) — the acts no reverse
// write can undo. All three stand on this surface now: Trash, Merge, and —
// since the grant plane gave People the write side (#825) — Revoke, whose
// title, body and both control words are the shared kit's
// (`_shared/grant-copy.ts`), which is why the cancel word is a prop: `Keep
// sharing` is the honest opposite of a revoke, where `Cancel` is the opposite
// of the other two.
//
// Full width, bottom-anchored, 12px radius on the top corners, one sentence of
// body, then `Cancel` (quiet) and the verb (destructive — outlined, never a
// fill), each filling half the row. Everything else in the app reports on the
// status line with Undo instead of asking first.

import React from "react";
import { Modal, Pressable, View } from "react-native";

import { VERBS } from "@centraid/blueprints/apps/people/people-copy";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";

export interface PeopleConfirmProps {
  visible: boolean;
  title: string;
  body: string;
  verb: string;
  /** The way out, where it is not the plain `Cancel`. */
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function PeopleConfirm({
  visible,
  title,
  body,
  verb,
  cancelLabel = VERBS.cancel,
  onConfirm,
  onCancel,
}: PeopleConfirmProps): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View
        style={{
          backgroundColor: colors.scrim,
          flex: 1,
          justifyContent: "flex-end",
        }}
      >
        {/* The scrim dismisses — the same out a swipe-down would be. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
          onPress={onCancel}
          style={{ flex: 1 }}
        />
        <View
          accessibilityViewIsModal
          style={{
            backgroundColor: colors.bgElev,
            borderColor: colors.line,
            borderTopLeftRadius: radii.lg,
            borderTopRightRadius: radii.lg,
            borderWidth: borders.hairline,
            gap: spacing[2],
            padding: spacing[4],
            paddingBottom: spacing[6],
          }}
        >
          <Text
            accessibilityRole="header"
            style={[t("title"), { color: colors.text }]}
          >
            {title}
          </Text>
          <Text style={[t("body"), { color: colors.textSoft }]}>{body}</Text>
          <View
            style={{
              flexDirection: "row",
              gap: spacing[2],
              paddingTop: spacing[2],
            }}
          >
            <View style={{ flex: 1 }}>
              <Button label={cancelLabel} onPress={onCancel} variant="quiet" />
            </View>
            <View style={{ flex: 1 }}>
              <Button label={verb} onPress={onConfirm} variant="destructive" />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}
