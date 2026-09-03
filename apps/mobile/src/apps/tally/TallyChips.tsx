// A CHOICE FROM A SET IS A CHIP (§3). Two typed fields in the whole of Add
// expense — description and amount — and everything else is one of these.
//
// One leaf, two shapes: a single-choice row (payer, group, category, date,
// currency, division) and a multi-choice row (who was on a receipt line). The
// difference is one prop, because they are the same control with a different
// number of marks lit.
import React, { useMemo } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export interface ChipOption {
  id: string;
  label: string;
}

export interface ChipsProps {
  options: readonly ChipOption[];
  value?: string;
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
