// TITLE role, not display serif (route content only; handoff :5536). No
// controls — Search is the lockup's, All apps the band's More tab.

import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { borders, pageMargin, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export const HOME_TITLE = "Home";

export default function HomeTitleRow(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{HOME_TITLE}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: {
      alignItems: "center",
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      gap: 8,
      paddingBottom: 14,
      paddingHorizontal: pageMargin,
    },
    title: { ...t("title"), color: colors.text, flex: 1 },
  });
