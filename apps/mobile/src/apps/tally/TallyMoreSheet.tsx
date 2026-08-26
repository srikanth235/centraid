// "More in Tally" — the band's fifth slot (Tally spec §1).
//
// Five rows, in the shared sheet's own order, with the shared tables' labels
// (`shelves.shelfLabel`) and meta (`route-copy.moreMeta`), so the sheet cannot
// drift from what the desktop rail calls the same surfaces.
//
// LENSES AND ACTS, NEVER PLACES. The four places are in the band; what is here
// is Recurring, Spending, Search, Trash and Export. Four of them are routes on
// this phone and one is not — Export's door is beside the gateway
// (SURFACES.md's seat column) — and the row says which, because a greyed row
// teaches that Export is broken rather than that it is elsewhere.

import React, { useMemo } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  MORE_FOOT,
  MORE_TITLE,
  VERBS,
} from "@centraid/blueprints/apps/tally/view-copy";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { TALLY_MORE_ROWS } from "./tally-band";
import type { TallyMoreRowKey } from "./tally-band";

/** What a row whose act lives on another seat says instead of its meta. */
const ELSEWHERE = "elsewhere";

export interface TallyMoreSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (key: TallyMoreRowKey) => void;
}

export default function TallyMoreSheet({
  visible,
  onClose,
  onSelect,
}: TallyMoreSheetProps): React.JSX.Element {
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
        accessibilityLabel={VERBS.close}
        onPress={onClose}
        style={[styles.scrim, { backgroundColor: colors.scrim }]}
      />
      <View
        style={[styles.sheet, { paddingBottom: insets.bottom + spacing[3] }]}
        accessibilityViewIsModal
      >
        <View style={styles.head}>
          <Text style={styles.headTitle}>{MORE_TITLE}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={VERBS.close}
            onPress={onClose}
            style={styles.closeButton}
          >
            <Icon name="X" size={16} color={colors.text} />
          </Pressable>
        </View>
        {TALLY_MORE_ROWS.map((row) => (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            accessibilityLabel={`${row.label}. ${row.meta}`}
            onPress={() => onSelect(row.key)}
            style={styles.row}
          >
            <Icon name={row.icon} size={16} color={colors.textFaint} />
            <Text style={styles.rowLabel}>{row.label}</Text>
            <Text style={styles.rowMeta}>
              {row.reach === "here" ? row.meta : ELSEWHERE}
            </Text>
          </Pressable>
        ))}
        <Text style={styles.foot}>{MORE_FOOT}</Text>
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
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    head: {
      alignItems: "center",
      flexDirection: "row",
      paddingBottom: spacing[3],
      paddingHorizontal: spacing[4],
    },
    headTitle: { ...t("smallStrong"), color: colors.text, flex: 1 },
    row: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      minHeight: 44,
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[2],
    },
    rowLabel: { ...t("small"), color: colors.text, flex: 1 },
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
      paddingTop: spacing[2],
      position: "absolute",
    },
  });
