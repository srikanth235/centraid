// ACCESS HISTORY — `locker/access` (SURFACES.md: custodian AND origin).
//
// WHAT A RECEIPT RECORDS, AND WHERE TO READ THEM. The `access` query exists
// now and the custodian seat renders the list; this seat does not, because the
// query is online-only by construction (receipts live in journal.db, which the
// replica does not carry) and pointing the phone at it is its own slice. So
// the screen states the register and names where the same receipts are read,
// rather than drawing an empty list that would say "nothing has happened"
// about a ledger nobody read here.
//
// Every sentence is the shared table's, so the day this seat gains the read it
// gains the desktop's screen from the same words.

import React, { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  ACCESS_HEAD,
  ACCESS_LEDE,
  ACCESS_NO_VALUES,
  ACCESS_REGISTER,
  ACCESS_WHERE,
} from "@centraid/blueprints/apps/locker/route-copy";

import { Text } from "../../kit/components/NativeText";
import SectionBlock from "../../kit/components/SectionBlock";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { LockerScreenProps } from "../../navigation";
import LockerScreen from "./LockerScreen";

export default function LockerAccessScreen({
  navigation,
}: LockerScreenProps<"LockerAccess">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <LockerScreen
      current="more"
      hideBand
      onBack={() => navigation.popTo("LockerHome", { destination: "items" })}
      route="access"
    >
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.head}>
          <Text accessibilityRole="header" style={styles.title}>
            {ACCESS_HEAD}
          </Text>
          <Text style={styles.lede}>{ACCESS_LEDE}</Text>
        </View>

        <SectionBlock label="What a receipt records" />
        {ACCESS_REGISTER.map(([kind, holds]) => (
          <View key={kind} style={styles.fact}>
            <Text style={styles.factKey}>{kind}</Text>
            <Text style={styles.factValue}>{holds}</Text>
          </View>
        ))}

        {/* The rule that governs the register itself, stated where the rows
            are named rather than where a list would be. */}
        <Text style={styles.note}>{ACCESS_NO_VALUES}</Text>
        <Text style={styles.note}>{ACCESS_WHERE}</Text>
      </ScrollView>
    </LockerScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fact: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    factKey: { ...t("eyebrow"), color: colors.textFaint, width: 92 },
    factValue: { ...t("small"), color: colors.text, flex: 1 },
    head: { gap: spacing[2], padding: spacing[4] },
    lede: { ...t("small"), color: colors.textSoft },
    note: {
      ...t("mono"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
    },
    scroll: { paddingBottom: spacing[6] },
    title: { ...t("title"), color: colors.text },
  });
