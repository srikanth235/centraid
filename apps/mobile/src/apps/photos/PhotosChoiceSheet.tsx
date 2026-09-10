// THE ONE CHOICE SHEET PHOTOS DRAWS (#1015, D4 and S7).
//
// Four surfaces asked "which album?" and "which face?" through
// `Alert.alert` with a row per option, which is an alert being used as a
// picker: no grabber, no scroll, iOS-only styling, a system cancel that is
// not the house's quiet verb, and a hard cap on how many rows fit before the
// system silently drops them — Album detail sliced its list to six for
// exactly that reason.
//
// A CHOICE IS A SHEET, and content pushes (D4). `SheetRoom` gives it the
// grabber, the noun in the title, the one quiet way out and — because a
// sheet is a `Modal` — a hosted status line, so the note a pick posts is
// read where the member is looking (audit B5).

import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { SheetRoom } from "../../kit/rooms";
import { spacing, t, useTheme } from "../../kit/theme";

export interface PhotosChoice {
  /** Stable across a re-read; the label is copy and may repeat. */
  id: string;
  label: string;
}

export interface PhotosChoiceSheetProps {
  visible: boolean;
  /** The question, with its noun in it — "Add to album", "Make key photo". */
  title: string;
  /** What is being acted on, under the title; a name or a count. */
  subject?: string;
  choices: readonly PhotosChoice[];
  /** Said instead of an empty list — never an empty sheet. */
  emptyNote?: string;
  onChoose: (id: string) => void;
  onClose: () => void;
}

export default function PhotosChoiceSheet({
  visible,
  title,
  subject,
  choices,
  emptyNote,
  onChoose,
  onClose,
}: PhotosChoiceSheetProps): React.JSX.Element | null {
  const { colors } = useTheme();
  return (
    <SheetRoom onClose={onClose} title={title} visible={visible}>
      <View>
        {subject ? (
          <Text style={[styles.subject, { color: colors.textSoft }]}>
            {subject}
          </Text>
        ) : null}
        {choices.length === 0 && emptyNote ? (
          <Text style={[styles.subject, { color: colors.textFaint }]}>
            {emptyNote}
          </Text>
        ) : null}
        {choices.map((choice) => (
          <Pressable
            accessibilityLabel={choice.label}
            accessibilityRole="button"
            key={choice.id}
            onPress={() => {
              onClose();
              onChoose(choice.id);
            }}
            style={[styles.row, { borderTopColor: colors.line }]}
          >
            <Text style={[styles.rowLabel, { color: colors.text }]}>
              {choice.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </SheetRoom>
  );
}

const styles = StyleSheet.create({
  row: {
    borderTopWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    minHeight: 44,
    paddingVertical: spacing[2],
  },
  rowLabel: { ...t("body") },
  subject: { ...t("mono"), paddingBottom: spacing[2] },
});
