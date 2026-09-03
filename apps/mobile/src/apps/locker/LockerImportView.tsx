import React, { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  LOCKER_ENTITY,
  batchMeta,
  verdictOf,
} from "@centraid/blueprints/apps/locker/import-model";
import type {
  StagedBatch,
  StagedRow,
} from "@centraid/blueprints/apps/locker/import-model";
import {
  IMPORT_CHOOSE,
  IMPORT_DISCARD,
  IMPORT_DRAFTS,
  IMPORT_DRAFTS_META,
  IMPORT_FILE_NOTE,
  IMPORT_FILE_ROW,
  IMPORT_HEAD,
  IMPORT_LEDE,
  IMPORT_NO_DRAFTS,
  IMPORT_NO_ROWS,
  IMPORT_OFFLINE,
  IMPORT_OTHER_ENTITY,
  IMPORT_PUBLISH,
  IMPORT_PUBLISH_NOTE,
  IMPORT_PUBLISH_ROW,
  IMPORT_REVIEW_OPEN,
  IMPORT_ROWS,
  IMPORT_ROWS_META,
  IMPORT_VERDICTS_ROW,
} from "@centraid/blueprints/apps/locker/route-copy";
import {
  IMPORT_VERDICT,
  IMPORT_VERDICT_CHIP,
} from "@centraid/blueprints/apps/locker/view-copy";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import SectionBlock from "../../kit/components/SectionBlock";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

const VERDICTS = ["new", "gapfill", "held"] as const;

export interface LockerImportViewProps {
  batches: readonly StagedBatch[] | null;
  rows: readonly StagedRow[] | null;
  openBatchId: string | null;
  note: string;
  offline: boolean;
  busy: boolean;
  onChoose: () => void;
  onOpen: (batchId: string) => void;
  onPublish: (batchId: string) => void;
  onDiscard: (batchId: string) => void;
}

export default function LockerImportView(
  props: LockerImportViewProps
): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const batches = props.batches ?? [];
  const rows = props.rows ?? [];

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.head}>
        <Text accessibilityRole="header" style={styles.title}>
          {IMPORT_HEAD}
        </Text>
        <Text style={styles.lede}>{IMPORT_LEDE}</Text>
      </View>

      <View style={styles.fact}>
        <Text style={styles.factKey}>{IMPORT_FILE_ROW}</Text>
        <View style={styles.factBody}>
          <Text style={styles.factNote}>
            {props.offline ? IMPORT_OFFLINE : IMPORT_FILE_NOTE}
          </Text>
          {props.offline ? null : (
            <Button
              disabled={props.busy}
              label={IMPORT_CHOOSE}
              onPress={props.onChoose}
            />
          )}
        </View>
      </View>

      <View style={styles.fact}>
        <Text style={styles.factKey}>{IMPORT_VERDICTS_ROW}</Text>
        <View style={styles.factBody}>
          {VERDICTS.map((key) => (
            <View key={key} style={styles.verdict}>
              <Text
                style={[
                  styles.chip,
                  key === "held" ? { color: colors.seam } : undefined,
                ]}
              >
                {IMPORT_VERDICT_CHIP[key]}
              </Text>
              <Text style={styles.factNote}>{IMPORT_VERDICT[key]}</Text>
            </View>
          ))}
        </View>
      </View>

      {props.note ? <Text style={styles.note}>{props.note}</Text> : null}

      {props.offline ? null : (
        <>
          <SectionBlock label={IMPORT_DRAFTS} meta={IMPORT_DRAFTS_META} />
          {props.batches === null ? (
            <SkeletonRows accessibilityLabel="Reading the drafts" />
          ) : batches.length === 0 ? (
            <Text style={styles.note}>{IMPORT_NO_DRAFTS}</Text>
          ) : (
            batches.map((batch) => (
              <View key={batch.batchId} style={styles.row}>
                <View style={styles.rowText}>
                  <Text numberOfLines={1} style={styles.rowTitle}>
                    {batch.batchId}
                  </Text>
                  <Text style={styles.rowMeta}>{batchMeta(batch)}</Text>
                </View>
                <Button
                  accessibilityHint={batch.batchId}
                  label={IMPORT_REVIEW_OPEN}
                  onPress={() => props.onOpen(batch.batchId)}
                />
              </View>
            ))
          )}

          {props.openBatchId ? (
            <>
              <SectionBlock label={IMPORT_ROWS} meta={IMPORT_ROWS_META} />
              {props.rows === null ? (
                <SkeletonRows accessibilityLabel="Reading the staged rows" />
              ) : rows.length === 0 ? (
                <Text style={styles.note}>{IMPORT_NO_ROWS}</Text>
              ) : (
                rows.map((row) => {
                  const key = verdictOf(row.disposition);
                  return (
                    <View key={row.seq} style={styles.row}>
                      <View style={styles.rowText}>
                        <Text numberOfLines={1} style={styles.rowTitle}>
                          {row.externalId}
                        </Text>
                        <Text style={styles.rowMeta}>
                          {[
                            IMPORT_VERDICT[key],
                            row.entityType === LOCKER_ENTITY
                              ? null
                              : IMPORT_OTHER_ENTITY,
                            row.mapping,
                            row.note,
                          ]
                            .filter(Boolean)
                            .join("  ·  ")}
                        </Text>
                      </View>
                      <Text
                        style={[
                          styles.chip,
                          key === "held" ? { color: colors.seam } : undefined,
                        ]}
                      >
                        {IMPORT_VERDICT_CHIP[key]}
                      </Text>
                    </View>
                  );
                })
              )}

              <View style={styles.fact}>
                <Text style={styles.factKey}>{IMPORT_PUBLISH_ROW}</Text>
                <View style={styles.factBody}>
                  <Text style={styles.factNote}>{IMPORT_PUBLISH_NOTE}</Text>
                  <View style={styles.acts}>
                    <Button
                      disabled={props.busy}
                      label={IMPORT_PUBLISH}
                      onPress={() => props.onPublish(props.openBatchId ?? "")}
                      variant="primary"
                    />
                    <Button
                      disabled={props.busy}
                      label={IMPORT_DISCARD}
                      onPress={() => props.onDiscard(props.openBatchId ?? "")}
                    />
                  </View>
                </View>
              </View>
            </>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    acts: { flexDirection: "row", gap: spacing[2], paddingTop: spacing[1] },
    chip: { ...t("eyebrow"), color: colors.textFaint },
    fact: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    factBody: { alignItems: "flex-start", flex: 1, gap: spacing[2] },
    factKey: { ...t("eyebrow"), color: colors.textFaint, width: 92 },
    factNote: { ...t("mono"), color: colors.textFaint },
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
    rowMeta: { ...t("mono"), color: colors.textFaint },
    rowText: { flex: 1, gap: 2, minWidth: 0 },
    rowTitle: { ...t("small"), color: colors.text },
    scroll: { paddingBottom: spacing[6] },
    title: { ...t("title"), color: colors.text },
    verdict: { flexDirection: "row", gap: spacing[2] },
  });
