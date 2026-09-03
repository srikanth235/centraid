import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { TEST_IDS } from "../../kit/test-ids";
import {
  setAppearance,
  spacing,
  t,
  useAppearance,
  useTheme,
  radii,
} from "../../kit/theme";
import type { Appearance, ThemeColors } from "../../kit/theme";
import SettingsSection from "./SettingsSection";

const OPTIONS: ReadonlyArray<{ value: Appearance; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function AppearanceSection(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const current = useAppearance();

  return (
    <SettingsSection label="Appearance">
      {/* The first section Settings publishes: proof of arrival with no scroll. */}
      <View style={styles.segment} testID={TEST_IDS.settings.appearance}>
        {OPTIONS.map((opt) => {
          const active = opt.value === current;
          return (
            <Pressable
              key={opt.value}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={opt.label}
              onPress={() => setAppearance(opt.value)}
              style={[styles.seg, active && styles.segActive]}
            >
              <Text style={[styles.segLabel, active && styles.segLabelActive]}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.help}>
        System follows your phone&apos;s light or dark setting.
      </Text>
    </SettingsSection>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    help: { ...t("small"), color: colors.textFaint, marginTop: spacing[3] },
    seg: {
      alignItems: "center",
      borderRadius: radii.md,
      flex: 1,
      paddingVertical: 9,
    },
    segActive: { backgroundColor: colors.accent },
    segLabel: { ...t("body"), color: colors.textSoft },
    segLabelActive: { color: colors.textInv },
    segment: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: 1,
      flexDirection: "row",
      gap: 4,
      padding: 3,
    },
  });
