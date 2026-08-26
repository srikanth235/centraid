// THE PERMIT GATE (README-Locker §2).
//
// A FULL-STOP OVERLAY, not an inline confirm — the sanctioned divergence this
// app argues for, and the phone keeps it: a modal that covers the item is the
// only way to make a reveal a decision rather than a tap. It names the ITEM,
// the FIELD, the permit's ~30-second life, and the receipt it writes, in four
// separate sentences because those are four separate facts.
//
// A REFUSAL IS RECEIPTED TOO, so the gate says so rather than silently
// re-arming: `permits.permitFromAuth` turns a wrong passphrase or a backed-off
// attempt into the message shown here.

import React, { useMemo, useState } from "react";
import { Modal, StyleSheet, View } from "react-native";

import {
  FIELD_LABEL,
  PERMIT_CANCEL,
  PERMIT_CONFIRM,
  PERMIT_GATE_ASK,
  PERMIT_GATE_LIFE,
  PERMIT_GATE_RECEIPT,
  LOCK_PLACEHOLDER,
  permitGateTitle,
} from "@centraid/blueprints/apps/locker/view-copy";

import Button from "../../kit/components/Button";
import { Text, TextInput } from "../../kit/components/NativeText";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export interface LockerPermitGateProps {
  /** The field the permit would be minted for; `null` closes the gate. */
  field: string | null;
  /** The item the gate is about, in the member's own words. */
  itemTitle: string;
  busy: boolean;
  /** The refusal, in the host's own words — backoff sentence included. */
  error: string;
  onConfirm: (secret: string) => void;
  onCancel: () => void;
}

export default function LockerPermitGate(
  props: LockerPermitGateProps
): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Modal
      animationType="fade"
      onRequestClose={props.onCancel}
      transparent
      visible={props.field !== null}
    >
      <View style={[{ backgroundColor: colors.scrim }, scrimStyle.scrim]}>
        {/* KEYED ON THE FIELD. The typed passphrase is component state, and a
            gate that reopened on a second field while holding the first
            field's keystrokes would be carrying one answer to another
            question. Remounting is the structural version of clearing it. */}
        {props.field === null ? null : (
          <PermitBody key={props.field} {...props} field={props.field} />
        )}
      </View>
    </Modal>
  );
}

const scrimStyle = StyleSheet.create({
  scrim: { flex: 1, justifyContent: "center" },
});

function PermitBody({
  field,
  itemTitle,
  busy,
  error,
  onConfirm,
  onCancel,
}: LockerPermitGateProps & { field: string }): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [secret, setSecret] = useState("");

  const label = FIELD_LABEL[field] ?? field;
  const submit = (): void => {
    if (busy || secret.length === 0) return;
    onConfirm(secret);
    setSecret("");
  };

  return (
    <View accessibilityViewIsModal style={styles.gate}>
      <Text accessibilityRole="header" style={styles.title}>
        {permitGateTitle(label)}
      </Text>
      <Text style={styles.item}>{itemTitle}</Text>
      <Text style={styles.body}>{PERMIT_GATE_ASK}</Text>
      <Text style={styles.body}>{PERMIT_GATE_LIFE}</Text>
      <Text style={styles.body}>{PERMIT_GATE_RECEIPT}</Text>

      <TextInput
        accessibilityLabel={LOCK_PLACEHOLDER}
        autoCapitalize="none"
        autoComplete="current-password"
        autoCorrect={false}
        onChangeText={setSecret}
        onSubmitEditing={submit}
        placeholder={LOCK_PLACEHOLDER}
        placeholderTextColor={colors.textFaint}
        secureTextEntry
        style={styles.input}
        value={secret}
      />

      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <View style={styles.acts}>
        <Button label={PERMIT_CANCEL} onPress={onCancel} />
        <Button
          disabled={busy || secret.length === 0}
          label={PERMIT_CONFIRM}
          onPress={submit}
          variant="primary"
        />
      </View>
    </View>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    acts: {
      flexDirection: "row",
      gap: spacing[2],
      justifyContent: "flex-end",
      paddingTop: spacing[3],
    },
    body: { ...t("small"), color: colors.textSoft },
    error: { ...t("small"), color: colors.net },
    gate: {
      backgroundColor: colors.bgElev,
      borderColor: colors.lineStrong,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      gap: spacing[2],
      margin: spacing[4],
      padding: spacing[4],
    },
    input: {
      ...t("body"),
      backgroundColor: colors.bg,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      marginTop: spacing[3],
      minHeight: 44,
      paddingHorizontal: spacing[3],
    },
    item: { ...t("mono"), color: colors.textFaint },
    title: { ...t("title"), color: colors.text },
  });
