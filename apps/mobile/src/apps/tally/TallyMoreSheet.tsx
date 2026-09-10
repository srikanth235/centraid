// "More in Tally" — the band's fifth slot (Tally spec §1).
//
// Five rows, in the shared sheet's own order, with the shared tables' labels
// (`shelves.shelfLabel`) and meta (`route-copy.moreMeta`), so the sheet cannot
// drift from what the desktop rail calls the same surfaces.
//
// The room is `SheetRoom` (#1015): grabber, the noun in the title, one quiet
// way out. The close glyph is gone — the room owns leaving.
//
// LENSES AND ACTS, NEVER PLACES. The four places are in the band; what is here
// is Recurring, Spending, Search, Trash and Export. Four of them are routes on
// this phone and one is not — Export's door is beside the gateway
// (SURFACES.md's seat column) — and the row says which, because a greyed row
// teaches that Export is broken rather than that it is elsewhere.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  MORE_FOOT,
  MORE_TITLE,
} from "@centraid/blueprints/apps/tally/view-copy";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { SheetRoom } from "../../kit/rooms";
import { borders, spacing, t, useTheme } from "../../kit/theme";
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
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <SheetRoom onClose={onClose} title={MORE_TITLE} visible={visible}>
      <View>
        {TALLY_MORE_ROWS.map((row) => (
          <Pressable
            accessibilityLabel={`${row.label}. ${row.meta}`}
            accessibilityRole="button"
            key={row.key}
            onPress={() => onSelect(row.key)}
            style={styles.row}
          >
            <Icon color={colors.textFaint} name={row.icon} size={16} />
            <Text style={styles.rowLabel}>{row.label}</Text>
            <Text style={styles.rowMeta}>
              {row.reach === "here" ? row.meta : ELSEWHERE}
            </Text>
          </Pressable>
        ))}
        <Text style={styles.foot}>{MORE_FOOT}</Text>
      </View>
    </SheetRoom>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    foot: {
      ...t("mono"),
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      color: colors.textFaint,
      paddingVertical: spacing[3],
    },
    row: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      minHeight: 44,
      paddingVertical: spacing[2],
    },
    rowLabel: { ...t("small"), color: colors.text, flex: 1 },
    rowMeta: { ...t("mono"), color: colors.textFaint },
  });
