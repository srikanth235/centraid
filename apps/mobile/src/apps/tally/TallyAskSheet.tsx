import React, { useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { VERBS } from "@centraid/blueprints/apps/tally/view-copy";

import { Text } from "../../kit/components/NativeText";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export interface TallyAskChips {
  key: string;
  label: string;
  options: readonly (readonly [string, string])[];
  initial: string;
}

export interface TallyAsk {
  title: string;
  body: readonly string[];
  confirm?: string;
  field?: { label: string; placeholder: string; initial?: string };
  chips?: readonly TallyAskChips[];
  onConfirm?: (value: string, picks: Readonly<Record<string, string>>) => void;
}

export interface TallyAskSheetProps {
  ask: TallyAsk | null;
  onClose: () => void;
}

export default function TallyAskSheet({
  ask,
  onClose,
}: TallyAskSheetProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [value, setValue] = useState("");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<TallyAsk | null>(null);
  if (opened !== ask) {
    setOpened(ask);
    setValue(ask?.field?.initial ?? "");
    setPicks(
      Object.fromEntries(
        (ask?.chips ?? []).map((group) => [group.key, group.initial])
      )
    );
  }

  const disabled = ask?.field !== undefined && value.trim() === "";

  return (
    <Modal
      visible={ask !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={VERBS.close}
        onPress={onClose}
        style={[styles.scrim, { backgroundColor: colors.scrim }]}
      />
      {ask ? (
        <View
          accessibilityViewIsModal
          style={[styles.sheet, { paddingBottom: insets.bottom + spacing[4] }]}
        >
          <Text style={styles.title}>{ask.title}</Text>
          {ask.body.map((line) => (
            <Text key={line} style={styles.body}>
              {line}
            </Text>
          ))}
          {ask.field ? (
            <View style={styles.fieldWrap}>
              <Text style={styles.fieldLabel}>{ask.field.label}</Text>
              <TextInput
                accessibilityLabel={ask.field.label}
                autoFocus
                onChangeText={setValue}
                placeholder={ask.field.placeholder}
                placeholderTextColor={colors.textFaint}
                style={styles.input}
                value={value}
              />
            </View>
          ) : null}
          {(ask.chips ?? []).map((group) => (
            <View key={group.key} style={styles.fieldWrap}>
              <Text style={styles.fieldLabel}>{group.label}</Text>
              <View style={styles.chipRow}>
                {group.options.map(([id, label]) => {
                  const on = (picks[group.key] ?? group.initial) === id;
                  return (
                    <Pressable
                      key={id}
                      accessibilityRole="button"
                      accessibilityLabel={label}
                      accessibilityState={{ selected: on }}
                      onPress={() =>
                        setPicks((prior) => ({ ...prior, [group.key]: id }))
                      }
                      style={[styles.chip, on ? styles.chipOn : undefined]}
                    >
                      <Text style={styles.chipText}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}
          <View style={styles.acts}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={VERBS.close}
              onPress={onClose}
              style={styles.act}
            >
              <Text style={styles.actText}>{VERBS.close}</Text>
            </Pressable>
            {ask.confirm ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={ask.confirm}
                accessibilityState={{ disabled }}
                disabled={disabled}
                onPress={() => {
                  ask.onConfirm?.(value.trim(), picks);
                  onClose();
                }}
                style={[styles.act, styles.actPrimary]}
              >
                <Text
                  style={[
                    styles.actText,
                    disabled ? styles.actTextOff : styles.actTextOn,
                  ]}
                >
                  {ask.confirm}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    act: {
      alignItems: "center",
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      flex: 1,
      justifyContent: "center",
      minHeight: 44,
    },
    actPrimary: { borderColor: colors.lineStrong },
    actText: { ...t("control"), color: colors.text },
    actTextOff: { color: colors.textDisabled },
    actTextOn: { color: colors.text },
    acts: { flexDirection: "row", gap: spacing[2], marginTop: spacing[3] },
    body: { ...t("small"), color: colors.textSoft },
    chip: {
      alignItems: "center",
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      justifyContent: "center",
      minHeight: 36,
      paddingHorizontal: spacing[3],
    },
    chipOn: { backgroundColor: colors.bgSel, borderColor: colors.lineSel },
    chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
    chipText: { ...t("control"), color: colors.text },
    fieldLabel: { ...t("annotLabel"), color: colors.textFaint },
    fieldWrap: { gap: spacing[1], marginTop: spacing[2] },
    input: {
      ...t("small"),
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      minHeight: 44,
      paddingHorizontal: spacing[3],
    },
    scrim: { ...StyleSheet.absoluteFill },
    sheet: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderTopLeftRadius: radii.lg,
      borderTopRightRadius: radii.lg,
      borderWidth: borders.hairline,
      bottom: 0,
      gap: spacing[2],
      insetInlineEnd: 0,
      insetInlineStart: 0,
      padding: spacing[4],
      position: "absolute",
    },
    title: { ...t("bodyStrong"), color: colors.text },
  });
