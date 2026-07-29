import { Feather } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { family } from "../kit/theme";
import type { ThemeColors } from "../kit/theme";

export function parseCard(text: string): {
  cardholder: string;
  cardNumber: string;
  expiry: string;
} {
  const cardNumber =
    text.match(/\b(?:\d[ -]*?){13,19}\b/u)?.[0]?.replace(/\D/gu, "") ?? "";
  const expiry =
    text.match(/\b(?:0[1-9]|1[0-2])\s*[/.-]\s*\d{2,4}\b/u)?.[0] ?? "";
  const cardholder =
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(
        (line) =>
          /^[\p{L}][\p{L} .'-]{2,80}$/u.test(line) &&
          !/\b(?:visa|mastercard|debit|credit)\b/iu.test(line)
      ) ?? "";
  return { cardholder, cardNumber, expiry };
}

export function CloseHeader({
  colors,
  onClose,
}: {
  colors: ThemeColors;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close scan"
        onPress={onClose}
      >
        <Feather name="x" size={24} color={colors.ink} />
      </Pressable>
      <Text style={[styles.title, { color: colors.ink }]}>Scan & review</Text>
      <View style={styles.headerGap} />
    </View>
  );
}

export function PrimaryButton({
  label,
  disabled,
  onPress,
  colors,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.primary,
        { backgroundColor: colors.accent, opacity: disabled ? 0.55 : 1 },
      ]}
    >
      <Text style={[styles.primaryText, { color: colors.onAccent }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Field({
  label,
  colors,
  ...input
}: React.ComponentProps<typeof TextInput> & {
  label: string;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.ink2 }]}>{label}</Text>
      <TextInput
        {...input}
        accessibilityLabel={input.accessibilityLabel ?? label}
        placeholderTextColor={colors.ink3}
        style={[
          styles.input,
          input.multiline && styles.multiline,
          {
            backgroundColor: colors.bgElev,
            borderColor: colors.lineStrong,
            color: colors.ink,
          },
        ]}
      />
    </View>
  );
}

export function ChoiceRows({
  label,
  rows,
  selected,
  onSelect,
  colors,
}: {
  label: string;
  rows: Array<{ id: string; label: string }>;
  selected: string;
  onSelect: (id: string) => void;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.ink2 }]}>{label}</Text>
      <View style={styles.chips}>
        {rows.map((row) => (
          <Pressable
            key={row.id}
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${row.label}`}
            accessibilityState={{ selected: selected === row.id }}
            onPress={() => onSelect(row.id)}
            style={[
              styles.chip,
              {
                borderColor: selected === row.id ? colors.accent : colors.line,
              },
            ]}
          >
            <Text style={{ color: colors.ink }}>{row.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  camera: {
    borderRadius: 18,
    borderWidth: 1,
    height: 430,
    overflow: "hidden",
  },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  content: { gap: 14, padding: 20, paddingBottom: 60 },
  destination: { borderRadius: 11, borderWidth: 1, padding: 11 },
  destinationGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  field: { gap: 7 },
  fieldLabel: { fontFamily: family.sansBold, fontSize: 12 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 56,
    paddingHorizontal: 18,
  },
  headerGap: { width: 24 },
  help: { fontFamily: family.sansRegular, fontSize: 14, lineHeight: 20 },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    fontFamily: family.sansRegular,
    fontSize: 15,
    padding: 12,
  },
  lineCard: { borderRadius: 14, borderWidth: 1, gap: 9, padding: 12 },
  lineKind: {
    fontFamily: family.monoMedium,
    fontSize: 10,
    textTransform: "uppercase",
  },
  multiline: { minHeight: 150, textAlignVertical: "top" },
  permission: { flex: 1, justifyContent: "center", padding: 28 },
  primary: { alignItems: "center", borderRadius: 12, padding: 14 },
  primaryText: { fontFamily: family.sansBold, fontSize: 15 },
  safe: { flex: 1 },
  title: {
    flex: 1,
    fontFamily: family.displayBold,
    fontSize: 21,
    textAlign: "center",
  },
  total: { fontFamily: family.displayBold, fontSize: 18 },
});

export { styles as scanStyles };
