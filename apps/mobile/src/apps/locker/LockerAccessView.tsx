// THE RECEIPTS, AS A LIST (README-Locker §1 `locker/access`, §2 "Receipts").
//
// AN AUDIT SURFACE NEVER INVENTS A ROW. Every line here comes out of
// `consent.receipt` through the app's own `access` query; the projection that
// turns a receipt into a line is the SHARED `access-model.ts`, so this seat and
// the desktop cannot say different things about the same receipt.
//
// NO VALUE IS SHOWN. A reveal names the COLUMNS it opened and stops — that is
// `ACCESS_NO_VALUES`, and it is true because a receipt has never carried a
// value in the first place. NO REFUSAL IS HIDDEN: a denial lists like an
// allowance, with its own mark.
//
// AND THREE ANSWERS, NEVER ONE EMPTINESS. Offline, refused and empty are
// different facts: the read is online-only by construction, a refusal is not an
// empty history, and "no receipt has been written yet" is day one.

import React, { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  accessAt,
  accessMeta,
  accessVerb,
  accessWindowCopy,
} from "@centraid/blueprints/apps/locker/access-model";
import {
  ACCESS_EMPTY,
  ACCESS_EMPTY_BODY,
  ACCESS_ENTRIES,
  ACCESS_ENTRIES_META,
  ACCESS_HEAD,
  ACCESS_LEDE,
  ACCESS_NO_VALUES,
  ACCESS_OFFLINE,
  ACCESS_REGISTER,
  ACCESS_WHERE,
} from "@centraid/blueprints/apps/locker/route-copy";
import type { LockerAccessEntry } from "@centraid/blueprints/apps/locker/types";

import EmptyBlock from "../../kit/components/EmptyBlock";
import { Text } from "../../kit/components/NativeText";
import SectionBlock from "../../kit/components/SectionBlock";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

/** The word over a refused receipt. `--net` ink, and the only colour spent on
 *  this screen. */
const REFUSED = "REFUSED";

export interface LockerAccessViewProps {
  /** `null` before a read has landed, or after one was refused — nothing is
   *  empty until a read has come back. */
  entries: readonly LockerAccessEntry[] | null;
  window: { window: number; truncated: boolean } | null;
  /** The vault's own words for a refusal. Empty where there was none. */
  error: string;
  /** Receipts live in the journal, which this device does not carry. */
  offline: boolean;
  /** Item titles from the window this session already read, so a row names the
   *  item rather than its id. A receipt outside that window keeps its id. */
  titles: ReadonlyMap<string, string>;
}

export default function LockerAccessView(
  props: LockerAccessViewProps
): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const entries = props.entries ?? [];

  return (
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

      {/* The rule that governs every row below, stated before them. */}
      <Text style={styles.note}>{ACCESS_NO_VALUES}</Text>

      {props.offline ? (
        <Text style={styles.note}>{ACCESS_OFFLINE}</Text>
      ) : props.error ? (
        // A refusal is not an empty history: no list is drawn over it.
        <Text style={[styles.note, { color: colors.net }]}>{props.error}</Text>
      ) : props.entries === null ? (
        <SkeletonRows accessibilityLabel="Reading the receipts" />
      ) : (
        <>
          <SectionBlock label={ACCESS_ENTRIES} meta={ACCESS_ENTRIES_META} />
          {entries.length === 0 ? (
            <EmptyBlock body={ACCESS_EMPTY_BODY} title={ACCESS_EMPTY} />
          ) : (
            entries.map((entry) => (
              <View key={entry.receipt_id} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.rowVerb}>{accessVerb(entry)}</Text>
                  <Text style={styles.rowMeta}>
                    {accessMeta(
                      entry,
                      entry.item_id
                        ? (props.titles.get(entry.item_id) ?? entry.item_id)
                        : null
                    )}
                  </Text>
                </View>
                {entry.decision === "deny" ? (
                  <Text style={[styles.rowMark, { color: colors.net }]}>
                    {REFUSED}
                  </Text>
                ) : null}
                <Text style={styles.rowAt}>{accessAt(entry.occurred_at)}</Text>
              </View>
            ))
          )}
          {props.window && entries.length > 0 ? (
            <Text style={styles.foot}>
              {accessWindowCopy(entries.length, props.window.truncated)}
            </Text>
          ) : null}
        </>
      )}

      <Text style={styles.note}>{ACCESS_WHERE}</Text>
    </ScrollView>
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
    foot: {
      ...t("mono"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
    },
    head: { gap: spacing[2], padding: spacing[4] },
    lede: { ...t("small"), color: colors.textSoft },
    note: {
      ...t("mono"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
    },
    row: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[2],
      minHeight: 56,
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[2],
    },
    rowAt: { ...t("mono"), color: colors.textFaint },
    rowMark: { ...t("eyebrow") },
    rowMeta: { ...t("mono"), color: colors.textFaint },
    rowText: { flex: 1, gap: 2, minWidth: 0 },
    rowVerb: { ...t("small"), color: colors.text },
    scroll: { paddingBottom: spacing[6] },
    title: { ...t("title"), color: colors.text },
  });
