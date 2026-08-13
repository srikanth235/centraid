import React, { useMemo } from "react";
import { View, Pressable, StyleSheet } from "react-native";

import { identityInk } from "@centraid/design";
import type { IconName } from "@centraid/design";

import { borders, radii, spacing, t, useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import Icon from "./Icon";
import { Text } from "./NativeText";

export interface AppHeaderProps {
  title: string;
  subtitle?: string;
  color: string;
  iconKey: IconName;
  onBack: () => void;
}

export default function AppHeader({
  title,
  subtitle,
  color,
  iconKey,
  onBack,
}: AppHeaderProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.bar}>
      <Pressable
        accessibilityLabel="Back"
        accessibilityRole="button"
        onPress={onBack}
        hitSlop={12}
        style={styles.backBtn}
      >
        <Icon name="ArrowLeft" size={20} color={colors.text} />
      </Pressable>
      <View style={[styles.iconWrap, { backgroundColor: color }]}>
        <Icon
          name={iconKey}
          size={16}
          color={identityInk(color, colors.text, colors.textInv)}
        />
      </View>
      <View style={styles.titleWrap}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    backBtn: { padding: spacing[1] },
    bar: {
      alignItems: "center",
      backgroundColor: colors.bg,
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      paddingBottom: spacing[3],
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
    },
    iconWrap: {
      alignItems: "center",
      borderRadius: radii.sm,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    subtitle: { ...t("control"), color: colors.textFaint, marginTop: 2 },
    title: { ...t("bodyStrong"), color: colors.text },
    titleWrap: { flex: 1, minWidth: 0 },
  });
