import React, { useMemo } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

import PanelBlock from "../../kit/components/PanelBlock";
import type { PanelFact } from "../../kit/components/PanelBlock";
import { useTheme } from "../../kit/theme";
import type { RecordView } from "./data-model";
import { styles } from "./Data.styles";

export interface RecordSheetProps {
  record: RecordView | undefined;
  kindLabel: string;
  onClose: () => void;
}

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
