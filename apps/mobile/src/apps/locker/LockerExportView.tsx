// EXPORT — `locker/export` (README-Locker §6). THE ONE ACT THAT PRODUCES
// PLAINTEXT, and the surface is shaped by that fact rather than by the control.
//
// The consequence stands above every control and the confirm NAMES it, never
// asks whether the member is sure: the ask sets the gate, the gate is a full
// stop, and only its own verb issues the write. The two options that make the
// file worse are off unless asked for. WITHHELD OFFLINE, NEVER DISABLED — a
// mass reveal is never answered from a device's durable store, so the reason
// stands where the control would be.

import React, { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  EXPORT_COMMIT,
  EXPORT_COMMIT_NOTE,
  EXPORT_COMMIT_ROW,
  EXPORT_CONFIRM_LABEL,
  EXPORT_CONFIRM_TITLE,
  EXPORT_FORMAT_NOTE,
  EXPORT_FORMAT_ROW,
  EXPORT_FORMAT_VALUE,
  EXPORT_HEAD,
  EXPORT_HISTORY,
  EXPORT_LEDE_TAIL,
  EXPORT_OFFLINE,
  EXPORT_OPTIONS_NOTE,
  EXPORT_OPTIONS_ROW,
  EXPORT_TRASHED,
  EXPORT_WHAT_ROW,
  EXPORT_WHERE_NOTE,
  EXPORT_WHERE_ROW,
  EXPORT_WHERE_VALUE,
  exportWhat,
} from "@centraid/blueprints/apps/locker/route-copy";
import { EXPORT_LEDE } from "@centraid/blueprints/apps/locker/view-copy";

import Button from "../../kit/components/Button";
import ChipsBlock from "../../kit/components/ChipsBlock";
import { Text } from "../../kit/components/NativeText";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { EXPORT_HANDOFF } from "./locker-seat-copy";

/** The one word this gate's Cancel says. */
const CANCEL = "Cancel";

export interface LockerExportViewProps {
  /** How much would leave, from the window this session read. */
  items: number;
  offline: boolean;
  busy: boolean;
  includeTrashed: boolean;
  includeHistory: boolean;
  /** The full-stop gate is standing. Nothing writes while it is not answered. */
  confirming: boolean;
  onOption: (option: "trashed" | "history", on: boolean) => void;
  onAsk: () => void;
  onCancel: () => void;
  onRun: () => void;
}

export default function LockerExportView(
  props: LockerExportViewProps
): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.head}>
        <Text accessibilityRole="header" style={styles.title}>
          {EXPORT_HEAD}
        </Text>
        <Text style={[styles.lede, { color: colors.net }]}>
          {`${EXPORT_LEDE} ${EXPORT_LEDE_TAIL}`}
        </Text>
      </View>

      <View style={styles.fact}>
        <Text style={styles.factKey}>{EXPORT_WHAT_ROW}</Text>
        <Text style={styles.factValue}>{exportWhat(props.items)}</Text>
      </View>

      <View style={styles.fact}>
        <Text style={styles.factKey}>{EXPORT_FORMAT_ROW}</Text>
        <View style={styles.factBody}>
          <Text style={styles.factValue}>{EXPORT_FORMAT_VALUE}</Text>
          <Text style={styles.factNote}>{EXPORT_FORMAT_NOTE}</Text>
        </View>
      </View>

      <View style={styles.fact}>
        <Text style={styles.factKey}>{EXPORT_WHERE_ROW}</Text>
        <View style={styles.factBody}>
          <Text style={styles.factValue}>{EXPORT_WHERE_VALUE}</Text>
          <Text style={styles.factNote}>{EXPORT_WHERE_NOTE}</Text>
          {/* The seat's own half: which door the file leaves through. */}
          <Text style={styles.factNote}>{EXPORT_HANDOFF}</Text>
        </View>
      </View>

      <View style={styles.fact}>
        <Text style={styles.factKey}>{EXPORT_OPTIONS_ROW}</Text>
        <View style={styles.factBody}>
          <ChipsBlock
            accessibilityLabel={EXPORT_OPTIONS_ROW}
            chips={[
              {
                id: "trashed",
                label: EXPORT_TRASHED,
                on: props.includeTrashed,
                onPress: () => props.onOption("trashed", !props.includeTrashed),
              },
              {
                id: "history",
                label: EXPORT_HISTORY,
                on: props.includeHistory,
                onPress: () => props.onOption("history", !props.includeHistory),
              },
            ]}
          />
          <Text style={styles.factNote}>{EXPORT_OPTIONS_NOTE}</Text>
        </View>
      </View>

      <View style={styles.fact}>
        <Text style={styles.factKey}>{EXPORT_COMMIT_ROW}</Text>
        <View style={styles.factBody}>
          <Text style={styles.factNote}>
            {props.offline ? EXPORT_OFFLINE : EXPORT_COMMIT_NOTE}
          </Text>
          {props.offline ? null : (
            <Button
              disabled={props.busy || props.confirming}
              label={EXPORT_COMMIT}
              onPress={props.onAsk}
            />
          )}
        </View>
      </View>

      {props.confirming ? (
        <View style={styles.confirm}>
          <Text accessibilityRole="header" style={styles.confirmTitle}>
            {EXPORT_CONFIRM_TITLE}
          </Text>
          {/* The confirm restates the consequence — it does not ask whether
              the member is sure about something it declined to name. */}
          <Text style={styles.factNote}>{EXPORT_LEDE}</Text>
          <View style={styles.confirmActs}>
            <Button label={CANCEL} onPress={props.onCancel} />
            <Button
              disabled={props.busy}
              label={EXPORT_CONFIRM_LABEL}
              onPress={props.onRun}
              variant="destructive"
            />
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    confirm: {
      borderColor: colors.net,
      borderWidth: borders.hairline,
      gap: spacing[2],
      margin: spacing[4],
      padding: spacing[3],
    },
    confirmActs: { flexDirection: "row", gap: spacing[2] },
    confirmTitle: { ...t("smallStrong"), color: colors.text },
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
    factValue: { ...t("small"), color: colors.text, flex: 1 },
    head: { gap: spacing[2], padding: spacing[4] },
    lede: { ...t("small") },
    scroll: { paddingBottom: spacing[6] },
    title: { ...t("title"), color: colors.text },
  });
