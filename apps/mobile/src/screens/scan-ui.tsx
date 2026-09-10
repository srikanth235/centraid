import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Text, TextInput } from "../kit/components/NativeText";
import { family, pageMargin, radii, spacing, t } from "../kit/theme";
import type { ThemeColors } from "../kit/theme";

export { parseCard } from "@centraid/client/capture";

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
  // Disabled is a colour token on the leaf, not container opacity — opacity
  // would dim the fill AND the label together and silently invalidate the
  // label's own token-level contrast.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.primary,
        {
          backgroundColor: disabled ? colors.bgSunken : colors.accent,
        },
      ]}
    >
      <Text
        style={[
          styles.primaryText,
          { color: disabled ? colors.textDisabled : colors.textInv },
        ]}
      >
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
      <Text style={[styles.fieldLabel, { color: colors.textSoft }]}>
        {label}
      </Text>
      <TextInput
        {...input}
        accessibilityLabel={input.accessibilityLabel ?? label}
        placeholderTextColor={colors.textFaint}
        style={[
          styles.input,
          input.multiline && styles.multiline,
          {
            backgroundColor: colors.bgElev,
            borderColor: colors.lineStrong,
            color: colors.text,
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
      <Text style={[styles.fieldLabel, { color: colors.textSoft }]}>
        {label}
      </Text>
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
            <Text style={{ color: colors.text }}>{row.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  camera: {
    borderRadius: radii.lg,
    borderWidth: 1,
    height: 430,
    overflow: "hidden",
  },
  chip: {
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  content: { gap: spacing[4], padding: pageMargin, paddingBottom: spacing[6] },
  destination: { borderRadius: radii.lg, borderWidth: 1, padding: 11 },
  destinationGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  field: { gap: 7 },
  fieldLabel: { fontFamily: family.sansMedium, fontSize: t("mono").fontSize },
  help: {
    ...t("body"),
  },
  input: {
    borderRadius: radii.lg,
    borderWidth: 1,
    fontFamily: family.sansRegular,
    fontSize: t("body").fontSize,
    padding: 12,
  },
  lineCard: { borderRadius: radii.lg, borderWidth: 1, gap: 9, padding: 12 },
  lineKind: {
    fontFamily: family.sansMedium,
    fontSize: t("mono").fontSize,
    textTransform: "uppercase",
  },
  multiline: { minHeight: 150, textAlignVertical: "top" },
  permission: { flex: 1, justifyContent: "center", padding: 28 },
  primary: { alignItems: "center", borderRadius: radii.lg, padding: 14 },
  primaryText: { fontFamily: family.sansMedium, fontSize: t("body").fontSize },
  total: { fontFamily: family.sansMedium, fontSize: t("reading").fontSize },
});

export { styles as scanStyles };
