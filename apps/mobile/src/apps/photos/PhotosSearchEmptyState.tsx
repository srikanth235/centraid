import React, { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export default function PhotosSearchEmptyState({
  query,
  onClear,
}: {
  query: string;
  onClear: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <View style={styles.panel}>
        <Text style={styles.eyebrow}>No hits</Text>
        <Text style={styles.title}>Nothing matches “{query}”</Text>
        <Text style={styles.body}>
          Try a person, place, album, date, caption or file name.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={onClear}
          style={styles.action}
        >
          <Text style={styles.actionText}>Clear search</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    action: {
      alignSelf: "flex-start",
      minHeight: 44,
      justifyContent: "center",
    },
    actionText: { ...t("control"), color: colors.link },
    body: { ...t("reading"), color: colors.textSoft },
    eyebrow: { ...t("mono"), color: colors.textSoft },
    pad: { padding: spacing[4] },
    panel: {
      borderColor: colors.line,
      borderTopWidth: borders.hairline,
      gap: spacing[3],
      paddingTop: spacing[4],
    },
    title: { ...t("display"), color: colors.text },
  });
