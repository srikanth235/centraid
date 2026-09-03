// The "More in Docs" sheet (Binding Layer v12 handoff Part 2 §"The band";
// spec §1.5).
//
// The band is capped at five destinations, and Docs has more shelves than
// slots — the sixth onward live here: Recently changed, Starred, Trash,
// Storage, What Docs may read, Add to Docs. Labels and meta come from the
// shared `view-copy.ts` table (`docs-band.ts` selects the mobile six), so the
// sheet can never drift from what the web app calls the same shelves.
//
// Counts are deliberately absent: the sheet mounts over whichever screen is
// current and has no replica read of its own, and a placeholder number is the
// lie the shared table's "no meta where the spec printed a sample" rule
// exists to avoid. The rows that carry meta carry the spec's own prose rules.
import React, { useMemo } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  MORE_FOOTER,
  MORE_TITLE,
} from "@centraid/blueprints/apps/docs/view-copy";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { DOCS_MORE_SHEET_ROWS } from "./docs-band";
import type { DocsMoreRowKey } from "./docs-band";

export interface DocsMoreSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (key: DocsMoreRowKey) => void;
}

export default function DocsMoreSheet({
  visible,
  onClose,
  onSelect,
}: DocsMoreSheetProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        style={[styles.scrim, { backgroundColor: colors.scrim }]}
      />
      <View
        style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
        accessibilityViewIsModal
      >
        <View style={styles.head}>
          <Text style={styles.headTitle}>{MORE_TITLE}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            style={styles.closeButton}
          >
            <Icon name="X" size={16} color={colors.text} />
          </Pressable>
        </View>
        {DOCS_MORE_SHEET_ROWS.map((row) => (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            accessibilityLabel={
              row.meta ? `${row.label}. ${row.meta}` : row.label
            }
            onPress={() => onSelect(row.key)}
            style={styles.row}
          >
            <Icon name={row.icon} size={16} color={colors.textFaint} />
            <Text style={styles.rowLabel}>{row.label}</Text>
            {row.meta ? <Text style={styles.rowMeta}>{row.meta}</Text> : null}
          </Pressable>
        ))}
        <Text style={styles.foot}>{MORE_FOOTER}</Text>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    closeButton: {
      alignItems: "center",
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      height: 34,
      justifyContent: "center",
      width: 34,
    },
    foot: {
      ...t("mono"),
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      color: colors.textFaint,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    head: {
      alignItems: "center",
      flexDirection: "row",
      paddingBottom: 12,
      paddingHorizontal: 16,
    },
    headTitle: {
      ...t("smallStrong"),
      color: colors.text,
      flex: 1,
    },
    row: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: 12,
      minHeight: 44,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    rowLabel: {
      color: colors.text,
      flex: 1,
      ...t("small"),
    },
    rowMeta: { ...t("mono"), color: colors.textFaint },
    scrim: { ...StyleSheet.absoluteFill },
    sheet: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderTopLeftRadius: radii.lg,
      borderTopRightRadius: radii.lg,
      borderWidth: borders.hairline,
      bottom: 0,
      insetInlineEnd: 0,
      insetInlineStart: 0,
      paddingTop: 10,
      position: "absolute",
    },
  });
