import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { displayText } from "@centraid/blueprints/apps/_shared/untrusted";
import { SEALED_RUN } from "@centraid/blueprints/apps/locker/item-fields";
import {
  concealsInSeconds,
  revealedForSeconds,
} from "@centraid/blueprints/apps/locker/permits";
import { strength, useTotp } from "@centraid/blueprints/apps/locker/totp";
import {
  CONCEAL,
  COPY,
  FIELD_LABEL,
  REVEAL,
  SEALED_NOTE,
  SHOW_CODE,
  revealedNote,
} from "@centraid/blueprints/apps/locker/view-copy";

import { Text } from "../../kit/components/NativeText";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export interface FieldAct {
  label: string;
  onPress: () => void;
}

export interface LockerFieldRowProps {
  label: string;
  value?: string | null;
  note?: string;
  numeric?: boolean;
  acts?: readonly FieldAct[];
  children?: React.ReactNode;
}

export function LockerFieldRow({
  label,
  value,
  note,
  numeric,
  acts,
  children,
}: LockerFieldRowProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <Text style={styles.key}>{label}</Text>
      <View style={styles.main}>
        {value ? (
          <Text
            selectable
            style={numeric === true ? styles.valueNumeric : styles.value}
          >
            {displayText(value)}
          </Text>
        ) : null}
        {children}
        {note ? <Text style={styles.note}>{note}</Text> : null}
      </View>
      {acts && acts.length > 0 ? (
        <View style={styles.acts}>
          {acts.map((act) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${act.label}. ${label}`}
              key={act.label}
              onPress={() => act.onPress()}
              style={styles.act}
            >
              <Text style={styles.actText}>{act.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export interface LockerSealedFieldProps {
  label: string;
  field: string;
  revealed: string | null;
  revealedAt: number | null;
  now: number;
  note?: string;
  onReveal: (field: string) => void;
  onCopy: (field: string) => void;
  onConceal: (field: string) => void;
}

export function LockerSealedField(
  props: LockerSealedFieldProps
): React.JSX.Element {
  const open = props.revealed !== null && props.revealedAt !== null;
  const note = open
    ? revealedNote(
        revealedForSeconds(props.revealedAt ?? 0, props.now),
        concealsInSeconds(props.revealedAt ?? 0, props.now)
      )
    : (props.note ?? SEALED_NOTE);
  return (
    <LockerFieldRow
      acts={
        open
          ? [
              { label: COPY, onPress: () => props.onCopy(props.field) },
              { label: CONCEAL, onPress: () => props.onConceal(props.field) },
            ]
          : [
              { label: REVEAL, onPress: () => props.onReveal(props.field) },
              { label: COPY, onPress: () => props.onCopy(props.field) },
            ]
      }
      label={props.label}
      note={note}
      numeric
      value={open ? props.revealed : SEALED_RUN}
    />
  );
}

export interface LockerTotpFieldProps {
  seed: string | null;
  onReveal: () => void;
  onCopy: (code: string) => void;
}

export function LockerTotpField(
  props: LockerTotpFieldProps
): React.JSX.Element {
  const { code } = useTotp(props.seed);
  const shown = code ?? "••• •••";
  return (
    <LockerFieldRow
      acts={
        props.seed && code
          ? [{ label: COPY, onPress: () => props.onCopy(code) }]
          : [{ label: SHOW_CODE, onPress: props.onReveal }]
      }
      label={FIELD_LABEL.otp_seed ?? "One-time code"}
      note="Thirty-second steps · the seed is sealed like any other secret."
      numeric
      value={shown}
    />
  );
}

export function LockerStrengthField({
  password,
}: {
  password: string;
}): React.JSX.Element {
  const score = strength(password);
  return (
    <LockerFieldRow
      label="Strength"
      note="Scored against the same rule Review uses, so the two cannot disagree."
      value={`${score.label} · ${String(password.length)} characters`}
    />
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    act: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: spacing[2],
    },
    actText: { ...t("control"), color: colors.text },
    acts: { flexDirection: "row", gap: spacing[1] },
    key: {
      ...t("eyebrow"),
      color: colors.textFaint,
      paddingTop: spacing[1],
      width: 92,
    },
    main: { flex: 1, gap: spacing[1], minWidth: 0 },
    note: { ...t("mono"), color: colors.textFaint },
    row: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    value: { ...t("small"), color: colors.text },
    valueNumeric: { ...t("mono"), color: colors.text },
  });
