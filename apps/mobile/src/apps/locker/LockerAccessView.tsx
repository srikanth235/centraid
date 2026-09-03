// THE RECEIPTS, AS A LIST (README-Locker §1 `locker/access`, §2 "Receipts").
//
// AN AUDIT SURFACE NEVER INVENTS A ROW: the projection is the SHARED
// `access-model.ts`. NO VALUE IS SHOWN — a reveal names the COLUMNS it opened
// and stops. NO REFUSAL IS HIDDEN: a denial lists like an allowance. Offline,
// refused and empty stay three facts, never one emptiness.
import React, { useMemo } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import type { ListRenderItemInfo } from "react-native";

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

const REFUSED = "REFUSED";

export interface LockerAccessViewProps {
  entries: readonly LockerAccessEntry[] | null;
  window: { window: number; truncated: boolean } | null;
  error: string;
  offline: boolean;
  titles: ReadonlyMap<string, string>;
}

export default function LockerAccessView(
  props: LockerAccessViewProps
): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // Windowed (#883 C4); these three withhold the LIST, not rows.
  const listing = !props.offline && !props.error && props.entries !== null;
  const entries = listing ? (props.entries ?? []) : [];

  const renderItem = ({
    item,
  }: ListRenderItemInfo<LockerAccessEntry>): React.JSX.Element => (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowVerb}>{accessVerb(item)}</Text>
        <Text style={styles.rowMeta}>
          {accessMeta(
            item,
            item.item_id
              ? (props.titles.get(item.item_id) ?? item.item_id)
              : null
          )}
        </Text>
      </View>
      {item.decision === "deny" ? (
        <Text style={[styles.rowMark, { color: colors.net }]}>{REFUSED}</Text>
      ) : null}
      <Text style={styles.rowAt}>{accessAt(item.occurred_at)}</Text>
    </View>
  );

  const head = (
    <View>
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
        <Text style={[styles.note, { color: colors.net }]}>{props.error}</Text>
      ) : props.entries === null ? (
        <SkeletonRows accessibilityLabel="Reading the receipts" />
      ) : (
        <SectionBlock label={ACCESS_ENTRIES} meta={ACCESS_ENTRIES_META} />
      )}
    </View>
  );

  const foot = (
    <View>
      {props.window && entries.length > 0 ? (
        <Text style={styles.foot}>
          {accessWindowCopy(entries.length, props.window.truncated)}
        </Text>
      ) : null}
      <Text style={styles.note}>{ACCESS_WHERE}</Text>
    </View>
  );

  return (
    <FlatList
      contentContainerStyle={styles.scroll}
      data={entries}
      keyExtractor={(entry) => entry.receipt_id}
      ListEmptyComponent={
        listing ? (
          <EmptyBlock body={ACCESS_EMPTY_BODY} title={ACCESS_EMPTY} />
        ) : null
      }
      ListFooterComponent={foot}
      ListHeaderComponent={head}

      initialNumToRender={12}
      maxToRenderPerBatch={12}
      renderItem={renderItem}
      windowSize={7}
    />
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
