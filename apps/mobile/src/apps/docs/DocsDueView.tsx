// Coming due (handoff Part 2 §4; issue #821) — rendered HONESTLY ABSENT.
//
// Obligations are dates read out of documents by the `due` capability, staged
// as tentative appointments each carrying the passage it was read from — "the
// evidence is the feature. A date with no passage is a guess, and a guess
// must not enter the member's calendar."
//
// That capability is a consent that is OFF and has no runner in this wave
// (blueprints/apps/docs/capabilities.ts: "the only answer this wave can give
// is `off` — not because the app decided, but because there is no consent
// record to read and inventing one would be the exact failure"). There is no
// replica source for obligations, so this shelf shows nothing staged, says
// why in the capability's own words, and routes to the one place the consent
// can be given. Nothing is mocked; see INTEGRATION-NOTES.md → Withholdings.

import { useNavigation } from "@react-navigation/native";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { DCAPS } from "@centraid/blueprints/apps/docs/capabilities";

import { Text } from "../../kit/components/NativeText";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsShellNavigation } from "../../navigation";
import { DUE_EMPTY_ACTION, DUE_EMPTY_TITLE, dueEmptyBody } from "./docs-copy";

export default function DocsDueView(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const navigation = useNavigation<DocsShellNavigation>();
  const capability = DCAPS.find((entry) => entry.id === "due");

  return (
    <View style={styles.page}>
      <View style={styles.panel}>
        <Text style={styles.eyebrow}>Off</Text>
        <Text accessibilityRole="header" style={styles.title}>
          {DUE_EMPTY_TITLE}
        </Text>
        <Text style={styles.body}>{dueEmptyBody(capability?.what ?? "")}</Text>
        {capability ? (
          <View style={styles.facts}>
            <Fact label="where" value={capability.where} styles={styles} />
            <Fact label="leaves" value={capability.leaves} styles={styles} />
            <Fact label="writes" value={capability.writes} styles={styles} />
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={DUE_EMPTY_ACTION}
          onPress={() => navigation.navigate("DocsCapabilities")}
          style={styles.action}
        >
          <Text style={styles.actionLabel}>{DUE_EMPTY_ACTION}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Fact({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  return (
    <View style={styles.factRow}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    action: {
      alignSelf: "flex-start",
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      justifyContent: "center",
      marginTop: 8,
      minHeight: 44,
      paddingHorizontal: 18,
    },
    actionLabel: { ...t("control"), color: colors.text },
    body: { ...t("body"), color: colors.textSoft },
    eyebrow: { ...t("eyebrow"), color: colors.textFaint },
    factLabel: { ...t("mono"), color: colors.textFaint, width: 64 },
    factRow: { flexDirection: "row", gap: 8 },
    factValue: { ...t("small"), color: colors.textSoft, flex: 1 },
    facts: { gap: 4, paddingTop: 4 },
    page: { flex: 1, paddingHorizontal: 18, paddingTop: 8 },
    panel: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      gap: 8,
      padding: 16,
    },
    title: { ...t("title"), color: colors.text },
  });
