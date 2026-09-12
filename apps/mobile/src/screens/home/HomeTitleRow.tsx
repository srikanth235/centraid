// TITLE role, not display serif (route content only; handoff :5536). Search is
// the lockup's and All apps the band's More tab, so the row carries exactly ONE
// control: Settings (#1015 D6). Settings had no door from Home at all — it sat
// behind All apps, which a member on the springboard has no reason to open —
// and the cover's trailing slot is where the phone puts it.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { DESTINATION_MARKS } from "@centraid/design";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { TEST_IDS } from "../../kit/test-ids";
import { borders, pageMargin, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export const HOME_TITLE = "Home";

export default function HomeTitleRow({
  onSettings,
}: {
  onSettings: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{HOME_TITLE}</Text>
      {/* Still reachable from More too (#1015 D6): one place a member expects
          it and one they can browse to, never only the latter. */}
      <Pressable
        accessibilityLabel="Settings"
        accessibilityRole="button"
        hitSlop={8}
        onPress={onSettings}
        style={styles.settings}
        testID={TEST_IDS.home.settings}
      >
        <Icon name={DESTINATION_MARKS.settings} size={22} color={colors.text} />
      </Pressable>
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
    settings: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      marginEnd: -8,
      minWidth: 44,
    },
    title: { ...t("title"), color: colors.text, flex: 1 },
  });
