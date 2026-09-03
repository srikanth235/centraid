import React, { useMemo, useState } from "react";
import { Switch, View } from "react-native";

import Button from "../../kit/components/Button";
import { Text, TextInput } from "../../kit/components/NativeText";
import { useTheme } from "../../kit/theme";
import type { MobileOutboxRow } from "../../lib/gateway";
import {
  applyArtifactEdits,
  editableArtifactFields,
} from "../../lib/notifications-artifact-editor";
import { styles } from "./Approvals.styles";

export interface StagedEditFormProps {
  row: MobileOutboxRow;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (artifact: Record<string, unknown>) => void;
}

export function StagedEditForm({
  row,
  busy,
  onCancel,
  onSubmit,
}: StagedEditFormProps): React.JSX.Element {
  const { colors } = useTheme();
  const fields = useMemo(
    () => editableArtifactFields(row.artifact),
    [row.artifact]
  );
  const [edits, setEdits] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, field.value]))
  );
  const ink = useMemo(
    () => ({
      input: {
        backgroundColor: colors.bg,
        borderColor: colors.lineStrong,
        color: colors.text,
      },
      label: { color: colors.textFaint },
    }),
    [colors]
  );
  return (
    <View style={styles.form}>
      {fields.map((field) => (
        <View key={field.key} style={styles.field}>
          <Text style={[styles.factKey, ink.label]}>{field.label}</Text>
          <TextInput
            accessibilityLabel={field.label}
            editable={!busy}
            multiline={field.multiline}
            onChangeText={(value) =>
              setEdits((prior) => ({ ...prior, [field.key]: value }))
            }
            style={[
              styles.input,
              ink.input,
              field.multiline ? styles.inputTall : undefined,
            ]}
            value={edits[field.key] ?? ""}
          />
        </View>
      ))}
      <View style={styles.formActions}>
        {busy ? null : (
          <Button
            label="Approve with edits"
            onPress={() => onSubmit(applyArtifactEdits(row.artifact, edits))}
            variant="primary"
          />
        )}
        <Button label="Cancel" onPress={onCancel} variant="secondary" />
      </View>
    </View>
  );
}

export interface AlwaysAllowProps {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  label: string;
}

export function AlwaysAllow({
  checked,
  disabled,
  onChange,
  label,
}: AlwaysAllowProps): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View style={styles.toggleRow}>
      <Switch
        accessibilityLabel={label}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ false: colors.lineStrong, true: colors.text }}
        value={checked}
      />
    </View>
  );
}
