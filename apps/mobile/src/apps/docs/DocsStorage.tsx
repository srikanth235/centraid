// Storage (spec §4.5; #821) — what this PHONE can say about where the
// drive's bytes are, and nothing it cannot.
//
// The desktop screen prints byte totals ("18.4 GB · 2.1 GB could be
// released") from the gateway's own storage read; this seat has no such read,
// so the figures are WITHHELD and the absence is stated
// (`STORAGE_WITHHELD`). What IS shown is real: the custody projection the
// replica carries per current content item (blob.custody_state), counted per
// state in the same owner-facing words `format.ts`'s custody table uses.

import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import PushedPage from "../../kit/rooms/PushedPage";
import {
  borders,
  pageMargin,
  radii,
  spacing,
  t,
  useTheme,
} from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { STORAGE_ROWS, STORAGE_WITHHELD, storageStatus } from "./docs-copy";
import { useDocsRoom } from "./docs-room";
import { useDocs } from "./useDocs";

export default function DocsStorage(): React.JSX.Element {
  const room = useDocsRoom("more");
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const drive = useDocs();
  const active = useMemo(
    () => drive.documents.filter((doc) => !doc.trashed),
    [drive.documents]
  );
  const countByState = useMemo(() => {
    const counts = new Map<string, number>();
    for (const doc of active) {
      if (!doc.custody_state) continue;
      counts.set(doc.custody_state, (counts.get(doc.custody_state) ?? 0) + 1);
    }
    return counts;
  }, [active]);
  const unswept = active.filter((doc) => !doc.custody_state).length;

  return (
    <PushedPage
      backTo={room.backTo}
      band={room.band}
      chrome={room.chrome}
      onBack={room.handleBack}
      overlay={room.overlay}
      title={room.title}
    >
      <View style={styles.page}>
        <View style={styles.container}>
          {STORAGE_ROWS.map((row, index) => (
            <View
              key={row.state}
              style={[styles.row, index === 0 ? undefined : styles.rowRule]}
            >
              <Text style={styles.rowLabel}>{row.label}</Text>
              <Text
                style={[
                  styles.rowCount,
                  row.state === "missing" &&
                  (countByState.get(row.state) ?? 0) > 0
                    ? { color: colors.net }
                    : undefined,
                ]}
              >
                {countByState.get(row.state) ?? 0}
              </Text>
            </View>
          ))}
          {/* A content id absent from the custody projection means the sweep
              has not asserted a state — rendered as its own row rather than
              folded into a category the vault never claimed. */}
          <View style={[styles.row, styles.rowRule]}>
            <Text style={styles.rowLabel}>Not swept yet</Text>
            <Text style={styles.rowCount}>{unswept}</Text>
          </View>
        </View>
        <Text style={styles.caption}>{STORAGE_WITHHELD}</Text>
        <Text style={styles.status}>{storageStatus(active.length)}</Text>
      </View>
    </PushedPage>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    caption: {
      ...t("small"),
      color: colors.textFaint,
      paddingHorizontal: pageMargin,
      paddingTop: 8,
    },
    container: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      marginHorizontal: 18,
      overflow: "hidden",
    },
    page: { flex: 1, paddingTop: 8 },
    row: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      minHeight: 44,
      paddingHorizontal: spacing[3],
    },
    rowCount: { ...t("mono"), color: colors.text },
    rowLabel: { ...t("body"), color: colors.text, flexShrink: 1 },
    rowRule: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
    },
    status: {
      ...t("mono"),
      color: colors.textFaint,
      paddingHorizontal: pageMargin,
      paddingTop: 6,
    },
  });
