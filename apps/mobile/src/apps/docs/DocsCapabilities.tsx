// What Docs may read (Docs handoff Part 2 §12; #821) — "four
// capabilities, four separate consents, all off by default. A consent that
// enables more than it names is not consent."
//
// Every row is the shared capability record (`blueprints/apps/docs/
// capabilities.ts`), stating what it does, where it runs, what leaves the
// device (nothing) and what it writes. THE SWITCH IS NOT DRAWN: there is no
// consent record behind these yet (`capabilityOn` can only say `off` because
// nothing exists to read), and a live-looking control that flipped nothing
// would promise a consent nobody recorded — `CAPABILITY_SWITCH_WITHHELD`
// says exactly that on screen. When the record lands, this screen grows the
// real control (INTEGRATION-NOTES.md → Withholdings).
import React, { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import {
  CAPABILITIES_BODY,
  CAPABILITIES_TITLE,
  capabilitiesOnCount,
  capabilityOn,
  DCAPS,
} from "@centraid/blueprints/apps/docs/capabilities";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsScreenProps } from "../../navigation";
import { CAPABILITY_SWITCH_WITHHELD, capabilitiesStatus } from "./docs-copy";
import DocsScreen from "./DocsScreen";
import DocsShelfHeader from "./DocsShelfHeader";

export default function DocsCapabilities({
  navigation,
}: DocsScreenProps<"DocsCapabilities">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <DocsScreen current="more">
      <DocsShelfHeader title="What Docs may read" backTo="All" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text accessibilityRole="header" style={styles.title}>
          {CAPABILITIES_TITLE}
        </Text>
        <Text style={styles.body}>{CAPABILITIES_BODY}</Text>

        {DCAPS.map((capability) => (
          <View key={capability.id} style={styles.panel}>
            <View style={styles.panelHead}>
              <Text style={styles.name}>{capability.name}</Text>
              <Text style={styles.state}>
                {capabilityOn(capability.id) ? "On" : "Off"}
              </Text>
            </View>
            <Text style={styles.what}>{capability.what}</Text>
            <View style={styles.facts}>
              <Fact label="where" value={capability.where} styles={styles} />
              <Fact label="leaves" value={capability.leaves} styles={styles} />
              <Fact label="writes" value={capability.writes} styles={styles} />
            </View>
            {capability.id === "filing" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Proposed filing"
                onPress={() => navigation.navigate("DocsProposedFiling")}
                style={styles.productRow}
              >
                <Text style={styles.productLabel}>Proposed filing</Text>
                <Icon name="chevron-right" size={16} color={colors.textSoft} />
              </Pressable>
            ) : null}
          </View>
        ))}

        <Text style={styles.caption}>{CAPABILITY_SWITCH_WITHHELD}</Text>
        <Text style={styles.status}>
          {capabilitiesStatus(capabilitiesOnCount())}
        </Text>
      </ScrollView>
    </DocsScreen>
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
    body: { ...t("body"), color: colors.textSoft, paddingBottom: 12 },
    caption: { ...t("small"), color: colors.textFaint, paddingTop: 8 },
    factLabel: { ...t("mono"), color: colors.textFaint, width: 64 },
    factRow: { flexDirection: "row", gap: 8 },
    factValue: { ...t("small"), color: colors.textSoft, flex: 1 },
    facts: { gap: 4, paddingTop: 6 },
    name: { ...t("title"), color: colors.text, flex: 1 },
    panel: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      gap: 6,
      marginBottom: 12,
      padding: 14,
    },
    panelHead: { alignItems: "center", flexDirection: "row", gap: 8 },
    productLabel: { ...t("body"), color: colors.text, flex: 1 },
    productRow: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: 8,
      marginTop: 6,
      minHeight: 44,
    },
    scroll: { paddingBottom: 32, paddingHorizontal: 18, paddingTop: 8 },
    state: { ...t("eyebrow"), color: colors.textFaint },
    status: { ...t("mono"), color: colors.textFaint, paddingTop: 6 },
    title: { ...t("title"), color: colors.text, paddingBottom: 6 },
    what: { ...t("body"), color: colors.textSoft },
  });
