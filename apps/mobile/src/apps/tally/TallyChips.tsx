// A CHOICE FROM A SET IS A CHIP (§3). Two typed fields in the whole of Add
// expense — description and amount — and everything else is one of these.
//
// One leaf, two shapes: a single-choice row (payer, group, category, date,
// currency, division) and a multi-choice row (who was on a receipt line). The
// difference is one prop, because they are the same control with a different
// number of marks lit.

import DateTimePicker from "@react-native-community/datetimepicker";
import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { formatDateShort } from "../../kit/format";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export interface ChipOption {
  id: string;
  label: string;
}

export interface ChipsProps {
  options: readonly ChipOption[];
  /** Single choice: the one lit. */
  value?: string;
  /** Several choices: every one lit. */
  values?: readonly string[];
  onSelect: (id: string) => void;
  label: string;
}

export function Chips({
  options,
  value,
  values,
  onSelect,
  label,
}: ChipsProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const lit = (id: string): boolean =>
    values ? values.includes(id) : value === id;
  return (
    <View accessibilityLabel={label} style={styles.row}>
      {options.map((option) => {
        const on = lit(option.id);
        return (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: on }}
            onPress={() => onSelect(option.id)}
            style={[styles.chip, on ? styles.chipOn : undefined]}
          >
            <Text style={styles.chipText}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export interface TypedFieldProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
  numeric?: boolean;
}

/** One of the two typed fields — or one cell of an allocation table, which is
 *  the same control with a number in it. */
export function TypedField({
  label,
  placeholder,
  value,
  onChange,
  numeric,
}: TypedFieldProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <TextInput
      accessibilityLabel={label}
      keyboardType={numeric ? "decimal-pad" : "default"}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={colors.textFaint}
      style={styles.input}
      value={value}
    />
  );
}

export interface DateFieldProps {
  /** The day key the draft holds, `YYYY-MM-DD`. */
  value: string;
  onChange: (next: string) => void;
  /** The chip's word when no day has been picked off the calendar. */
  pickLabel: string;
  /** The spoken name of the control. */
  label: string;
  /** The vault's clock, so "today" is the vault's today. */
  now: string;
}

/** A DAY IS PICKED, NEVER TYPED (#1015, tally/findings #5). The composer used
 *  to offer a free-text field holding `2026-09-10`: an ISO string, typed on a
 *  phone, in the one app whose siblings all humanise their dates. This is the
 *  platform picker behind one chip, and the chip states the day it holds in the
 *  product's own register (`10 Sep`). */
export function DateField({
  value,
  onChange,
  pickLabel,
  label,
  now,
}: DateFieldProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [open, setOpen] = useState(false);
  const today = now.slice(0, 10);
  const yesterday = dayBefore(today);
  // The chip says the day only when the day is one the two shorthand chips do
  // not already say; otherwise it is the invitation to open the calendar.
  const picked =
    value !== "" && value !== today && value !== yesterday
      ? formatDateShort(value, now)
      : "";
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={{ selected: picked !== "" }}
        onPress={() => setOpen(true)}
        style={[styles.chip, picked === "" ? undefined : styles.chipOn]}
      >
        <Text style={styles.chipText}>
          {picked === "" ? pickLabel : picked}
        </Text>
      </Pressable>
      {open ? (
        <DateTimePicker
          display="default"
          mode="date"
          onChange={(_event, next) => {
            setOpen(false);
            if (next) onChange(dayKeyOf(next));
          }}
          value={new Date(`${value === "" ? today : value}T00:00:00`)}
        />
      ) : null}
    </View>
  );
}

/** The day key of a local `Date`, read in local time: a UTC slice would move a
 *  member west of Greenwich to the day before the one they tapped. */
function dayKeyOf(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

function dayBefore(dayKey: string): string {
  const stamp = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(stamp)) return "";
  return new Date(stamp - 86_400_000).toISOString().slice(0, 10);
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
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
    chipText: { ...t("control"), color: colors.text },
    input: {
      ...t("small"),
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      minHeight: 44,
      paddingHorizontal: spacing[3],
    },
    row: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  });
