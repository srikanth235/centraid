import React, { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

/** The honest empty-query state: no request has run yet. */
export default function PhotosSearchRestingState(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <View style={styles.panel}>
        <Text style={styles.eyebrow}>Nothing typed</Text>
        <Text style={styles.title}>Search the whole library</Text>
        <Text style={styles.body}>
          Not only the photographs already loaded — try one of these.
        </Text>
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: { ...t("reading"), color: colors.textSoft },
    eyebrow: { ...t("eyebrow"), color: colors.textSoft },
    pad: {
      gap: spacing[4],
      paddingBottom: spacing[4],
      paddingTop: spacing[4],
    },
    panel: {
      borderColor: colors.line,
      borderTopWidth: borders.hairline,
      gap: spacing[3],
      paddingTop: spacing[4],
    },
    title: { ...t("display"), color: colors.text },
  });
