// THE ONE CONFIRM, and the one composer — because §6 writes both as sentences.
//
// Every guard in Tally is a paragraph that names the consequence and then
// offers the act: leaving a group, archiving one, trashing an expense, and the
// removal guard that REFUSES and says why. A refusal is the same sheet with no
// confirming verb — the member reads why and closes it — rather than a
// different component, so the two can never drift apart in tone.
//
// The room is `SheetRoom` (#1015): the grabber, the title, the one outlined
// `--net` verb and the quiet way out are the room's; this file supplies the
// paragraphs, the field and the chips.
//
// It doubles as the composer for the two acts that need one typed word: a
// friend's name and a group's. `Alert.prompt` is iOS-only, and a control that
// exists on one platform is a control this app cannot rely on.

import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { SheetRoom } from "../../kit/rooms";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

/** One closed set, drawn as chips — because a choice from a set is a chip and
 *  never a typed word (§3: "everything else is a chip set"). */
export interface TallyAskChips {
  key: string;
  label: string;
  options: readonly (readonly [string, string])[];
  initial: string;
}

export interface TallyAsk {
  title: string;
  /** One paragraph per claim: §6 holds two of these as a PAIR of sentences,
   *  and they render one after the other so what a member reads is the line
   *  unaltered. */
  body: readonly string[];
  /** Absent on a REFUSAL: there is nothing to confirm, only something to read. */
  confirm?: string;
  /** A typed field, for the two acts that need one word. */
  field?: { label: string; placeholder: string; initial?: string };
  /** The closed sets this act also needs — a group's icon and its colour. */
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
}: TallyAskSheetProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [value, setValue] = useState("");
  const [picks, setPicks] = useState<Record<string, string>>({});
  // A NEW ASK RESETS THE FIELDS DURING RENDER, not in an effect. What is typed
  // belongs to the ask that opened; deriving it from `ask` in an effect would
  // paint one ask's answer under the next one's question for a frame.
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

  if (!ask) return null;
  return (
    <SheetRoom
      onClose={onClose}
      primary={
        ask.confirm
          ? {
              // Every one of these asks is a REMOVAL, an archive or a leave —
              // the outlined `--net` verb, never a filled commit (S7).
              dangerous: true,
              disabled,
              label: ask.confirm,
              onPress: () => {
                ask.onConfirm?.(value.trim(), picks);
                onClose();
              },
            }
          : undefined
      }
      title={ask.title}
      visible
    >
      <View style={styles.body}>
        {ask.body.map((line) => (
          <Text key={line} style={styles.line}>
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
                    accessibilityLabel={label}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    key={id}
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
      </View>
    </SheetRoom>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: { gap: spacing[2] },
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
    line: { ...t("small"), color: colors.textSoft },
  });
