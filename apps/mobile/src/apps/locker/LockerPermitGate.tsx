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
  field: string | null;
  itemTitle: string;
  busy: boolean;
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
