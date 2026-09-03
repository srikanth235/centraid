import { useNavigation } from "@react-navigation/native";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { TEST_IDS } from "../../kit/test-ids";
import { t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsShellNavigation } from "../../navigation";

export default function DocsShelfHeader({
  title,
  backTo,
  trailing,
}: {
  title: string;
  backTo: string;
  trailing?: React.ReactNode;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const navigation = useNavigation<DocsShellNavigation>();
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Back to ${backTo}`}
        onPress={() => navigation.goBack()}
        style={styles.back}
        testID={TEST_IDS.docs.breadcrumb}
      >
        <Icon name="chevron-left" size={22} color={colors.text} />
        <Text style={styles.backLabel}>{backTo}</Text>
      </Pressable>
      <Text numberOfLines={1} style={styles.title}>
        {title}
      </Text>
      {trailing}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    back: {
      alignItems: "center",
      flexDirection: "row",
      gap: 2,
      minHeight: 44,
      paddingEnd: 8,
    },
    backLabel: { ...t("control"), color: colors.text },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
      minHeight: 44,
      paddingEnd: 18,
      paddingStart: 10,
    },
    title: { ...t("title"), color: colors.text, flex: 1, textAlign: "center" },
  });
