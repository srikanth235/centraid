// THE ITEM ROW (README-Locker §5, "Item row"), drawn once for every list.
//
// Type chip · title · meta sentence · star · verdict chip. Items, Review,
// Search and Trash all compose THIS row out of `format.ts`'s three
// derivations, so a row cannot read differently in one list than another —
// which is the drift `format.ts` exists to close, and drawing it twice on this
// seat would reopen.
//
// THE CHIP IS TWO LETTERS, NOT A GLYPH (§7: never a lock icon standing in for
// a sentence). The verdict chip takes `--net` for compromised and the seam for
// the rest, because compromised is the one verdict with a consequence outside
// this device.

import React, { memo, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { displayText } from "@centraid/blueprints/apps/_shared/untrusted";
import {
  metaSentence,
  typeChip,
  verdictOf,
} from "@centraid/blueprints/apps/locker/format";
import type { LockerRow as LockerRowData } from "@centraid/blueprints/apps/locker/types";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export interface LockerRowProps {
  row: LockerRowData;
  /** The one quiet verb this list puts on the row, if any. */
  act?: { label: string; onPress: () => void };
  onOpen: (row: LockerRowData) => void;
}

/** Stable key for every Locker list. */
export function lockerRowKey(row: LockerRowData): string {
  return row.item_id;
}

function LockerRowView({
  row,
  act,
  onOpen,
}: LockerRowProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const verdict = verdictOf(row);
  const title = displayText(row.title);
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={() => onOpen(row)}
        style={styles.main}
      >
        <View style={styles.chip}>
          <Text style={styles.chipText}>{typeChip(row.type)}</Text>
        </View>
        <View style={styles.text}>
          <Text numberOfLines={1} style={styles.title}>
            {title}
          </Text>
          <Text numberOfLines={1} style={styles.meta}>
            {metaSentence(row)}
          </Text>
        </View>
        {row.favorite ? (
          <Icon name="Star" size={14} color={colors.textFaint} />
        ) : null}
        {verdict ? (
          <Text
            style={[
              styles.verdict,
              {
                borderColor: verdict.tone === "net" ? colors.net : colors.seam,
                color: verdict.tone === "net" ? colors.net : colors.textSoft,
              },
            ]}
          >
            {verdict.label}
          </Text>
        ) : null}
      </Pressable>
      {act ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${act.label}. ${title}`}
          onPress={() => act.onPress()}
          style={styles.act}
        >
          <Text style={styles.actText}>{act.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Memoized: a list of 300 rows re-renders on every countdown tick otherwise. */
export const LockerRow = memo(LockerRowView);

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    act: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: spacing[3],
    },
    actText: { ...t("control"), color: colors.text },
    chip: {
      alignItems: "center",
      backgroundColor: colors.bgSunken,
      borderRadius: radii.sm,
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    chipText: { ...t("mono"), color: colors.textSoft },
    main: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      gap: spacing[3],
      minHeight: 56,
      minWidth: 0,
      paddingVertical: spacing[2],
    },
    meta: { ...t("mono"), color: colors.textFaint },
    row: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      paddingHorizontal: spacing[4],
    },
    text: { flex: 1, gap: 2, minWidth: 0 },
    title: { ...t("small"), color: colors.text },
    verdict: {
      ...t("control"),
      borderRadius: radii.sm,
      borderWidth: borders.hairline,
      paddingHorizontal: spacing[2],
      paddingVertical: 2,
    },
  });
