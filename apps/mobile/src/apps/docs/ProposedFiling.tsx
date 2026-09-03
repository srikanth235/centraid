import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { DCAPS } from "@centraid/blueprints/apps/docs/capabilities";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsScreenProps } from "../../navigation";
import { dueEmptyBody, filingStatus } from "./docs-copy";
import DocsScreen from "./DocsScreen";
import DocsShelfHeader from "./DocsShelfHeader";

export default function ProposedFiling({
  navigation,
}: DocsScreenProps<"DocsProposedFiling">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const capability = DCAPS.find((entry) => entry.id === "filing");

  return (
    <DocsScreen current="more">
      <DocsShelfHeader title="Proposed filing" backTo="All" />
      <View style={styles.page}>
        <View style={styles.panel}>
          <Text style={styles.eyebrow}>Off</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Nothing has been proposed
          </Text>
          <Text style={styles.body}>
            {dueEmptyBody(capability?.what ?? "")}
          </Text>
          <Text style={styles.body}>
            It never files anything on its own — every proposal would wait here
            for you to accept, edit or reject it.
          </Text>
          <Button
            label="What Docs may read"
            onPress={() => navigation.navigate("DocsCapabilities")}
            style={styles.action}
          />
        </View>
        <Text style={styles.status}>{filingStatus(0)}</Text>
      </View>
    </DocsScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    action: { alignSelf: "flex-start", marginTop: 8 },
    body: { ...t("body"), color: colors.textSoft },
    eyebrow: { ...t("eyebrow"), color: colors.textFaint },
    page: { flex: 1, paddingHorizontal: 18, paddingTop: 8 },
    panel: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      gap: 8,
      padding: 16,
    },
    status: { ...t("mono"), color: colors.textFaint, paddingTop: 8 },
    title: { ...t("title"), color: colors.text },
  });
