// One record, opened (#765).
//
// The record table's overflow offers `Open the record`, and on this surface
// there is nowhere else for a raw store row to go: the phone has no row editor
// and no per-record route. So opening one shows what the store holds — every
// column the browse route sent, in the order it sent them — on the same fact
// plate the rest of the place uses (`PanelBlock`, whose key column is the
// reason the values line up instead of stepping in and out).
//
// Read only, and it says so: `lib/atlas.ts` exposes the four owner census
// READS and nothing else, because a row edit on this gateway is a journalled
// operator command, not a PATCH the phone can make.

import React, { useMemo } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

import PanelBlock from "../../kit/components/PanelBlock";
import type { PanelFact } from "../../kit/components/PanelBlock";
import { useTheme } from "../../kit/theme";
import type { RecordView } from "./data-model";
import { styles } from "./Data.styles";

export interface RecordSheetProps {
  record: RecordView | undefined;
  /** The kind the record belongs to, for the plate's eyebrow. */
  kindLabel: string;
  onClose: () => void;
}

/** A cell, as one line of text. Structured columns (JSON blobs) are shown as
 *  the store wrote them rather than parsed and re-worded here. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value || "—";
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

export default function RecordSheet({
  record,
  kindLabel,
  onClose,
}: RecordSheetProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const facts = useMemo<PanelFact[]>(
    () =>
      record
        ? Object.entries(record.row).map(([column, value]) => ({
            key: column,
            label: column,
            value: cellText(value),
          }))
        : [],
    [record]
  );
  if (!record) return null;
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      transparent
      visible={true}
    >
      <Pressable
        accessibilityLabel="Dismiss"
        onPress={onClose}
        style={[styles.scrim, { backgroundColor: colors.scrim }]}
      />
      <View
        style={[
          styles.sheet,
          { backgroundColor: colors.bg, borderTopColor: colors.line },
        ]}
      >
        <ScrollView contentContainerStyle={styles.sheetBody}>
          <PanelBlock
            eyebrow={kindLabel}
            facts={facts}
            action2={{ label: "Close", onPress: onClose }}
            title={record.record.title}
          />
        </ScrollView>
      </View>
    </Modal>
  );
}
