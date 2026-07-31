import React, { useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import Button from "../kit/components/Button";
import { radii, spacing, t, useTheme } from "../kit/theme";
import type { ThemeColors } from "../kit/theme";
import type { MobileOutboxRow } from "../lib/gateway";
import {
  applyArtifactEdits,
  editableArtifactFields,
} from "../lib/notifications-artifact-editor";

export default function OutboxDecisionCard(props: {
  row: MobileOutboxRow;
  busy: boolean;
  focused: boolean;
  onApprove: (
    artifact: Record<string, unknown> | undefined,
    alwaysAllow: boolean
  ) => Promise<void>;
  onDeny: () => Promise<void>;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [expanded, setExpanded] = useState(props.focused);
  const [editing, setEditing] = useState(false);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const fields = useMemo(
    () => editableArtifactFields(props.row.artifact),
    [props.row.artifact]
  );
  const [edits, setEdits] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, field.value]))
  );

  const title =
    fields.find((field) =>
      ["title", "subject", "name", "text"].includes(field.key)
    )?.value ?? props.row.target;

  return (
    <View
      style={[
        styles.card,
        props.focused && { borderColor: colors.accent, borderWidth: 2 },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${title}, external write approval`}
        onPress={() => setExpanded((value) => !value)}
      >
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.detail}>
          {props.row.actor ?? props.row.actorKind} ·{" "}
          {props.row.connection.label}
        </Text>
      </Pressable>

      {expanded ? (
        <View style={styles.artifact}>
          {editing
            ? fields.map((field) => (
                <View key={field.key} style={styles.field}>
                  <Text style={styles.label}>{field.label}</Text>
                  <TextInput
                    accessibilityLabel={field.label}
                    editable={!props.busy}
                    multiline={field.multiline}
                    onChangeText={(value) =>
                      setEdits((prior) => ({ ...prior, [field.key]: value }))
                    }
                    style={[
                      styles.input,
                      field.multiline && styles.multilineInput,
                    ]}
                    value={edits[field.key] ?? ""}
                  />
                </View>
              ))
            : Object.entries(props.row.artifact).map(([key, value]) => (
                <View key={key} style={styles.previewRow}>
                  <Text style={styles.label}>{key.replaceAll("_", " ")}</Text>
                  <Text style={styles.value} selectable>
                    {typeof value === "string"
                      ? value
                      : JSON.stringify(value, null, 2)}
                  </Text>
                </View>
              ))}

          <View style={styles.alwaysRow}>
            <View style={styles.alwaysCopy}>
              <Text style={styles.alwaysTitle}>Always allow this pattern</Text>
              <Text style={styles.detail}>
                Future matching writes can send without stopping here.
              </Text>
            </View>
            <Switch
              accessibilityLabel="Always allow this pattern"
              disabled={props.busy}
              onValueChange={setAlwaysAllow}
              trackColor={{ false: colors.lineStrong, true: colors.accent }}
              value={alwaysAllow}
            />
          </View>
        </View>
      ) : null}

      <View style={styles.actions}>
        {props.row.canEdit && fields.length > 0 ? (
          <Button
            label={editing ? "Cancel edit" : "Edit"}
            variant="soft"
            disabled={props.busy}
            onPress={() => {
              setExpanded(true);
              setEditing((value) => !value);
            }}
            style={styles.button}
          />
        ) : null}
        <Button
          label={editing ? "Approve with edits" : "Approve"}
          icon="Check"
          disabled={props.busy}
          onPress={() =>
            void props.onApprove(
              editing
                ? applyArtifactEdits(props.row.artifact, edits)
                : undefined,
              alwaysAllow
            )
          }
          style={styles.button}
        />
        <Button
          label="Deny"
          icon="X"
          variant="soft"
          disabled={props.busy}
          onPress={() => void props.onDeny()}
          style={styles.button}
        />
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing[2],
      marginTop: spacing[3],
    },
    alwaysCopy: { flex: 1 },
    alwaysRow: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: spacing[3],
      paddingTop: spacing[3],
    },
    alwaysTitle: { ...t("small"), color: colors.ink },
    artifact: { gap: spacing[3], marginTop: spacing[3] },
    button: { flexGrow: 1 },
    card: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      padding: spacing[4],
    },
    detail: { ...t("small"), color: colors.ink3, marginTop: 3 },
    field: { gap: spacing[1] },
    input: {
      ...t("body"),
      backgroundColor: colors.bg,
      borderColor: colors.lineStrong,
      borderRadius: radii.sm,
      borderWidth: 1,
      color: colors.ink,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
    },
    label: {
      ...t("small"),
      color: colors.ink3,
      textTransform: "capitalize",
    },
    multilineInput: { minHeight: 104, textAlignVertical: "top" },
    previewRow: { gap: spacing[1] },
    title: { ...t("bodyStrong"), color: colors.ink },
    value: { ...t("body"), color: colors.ink2 },
  });
