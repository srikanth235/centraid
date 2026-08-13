// The two controls that belong to ONE staged write (#765), folded out of the
// old `components/OutboxDecisionCard`.
//
// That card carried the whole decision — title, artifact dump, edit form,
// always-allow switch and three buttons — inside one bordered plate, once per
// queued item. The v9 shape promotes ONE write to a panel and leaves the rest
// as rows, so the card's plate, its title line and its artifact preview are
// gone: `PanelBlock` states them better (the body is quoted because the words
// are somebody else's, and every address is a fact in a keyed column). What
// survives is what the panel cannot express — an editable form and a standing
// consent toggle — and it survives as the CHILDREN of two rows under the
// panel, because a deny is not a smaller approve and neither is a grant.

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

/**
 * Edit-then-approve. Only scalar text fields are editable (the shape the
 * gateway's drift guard accepts); everything else rides through unchanged, so
 * what is sent is still exactly what the panel quoted plus what was typed.
 */
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

/** The standing-consent toggle. It mints a grant, which is why the row it
 *  sits in says so and the grants section below can take it back. */
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
