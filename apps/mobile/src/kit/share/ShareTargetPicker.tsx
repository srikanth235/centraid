// THE FIRST-SHARE PICKER (issue #712, A3) — asked at the moment of intent.
//
// The alternative this replaces was a disabled *Copy to Sharing* carrying the
// sentence "There is nowhere to share to on this device yet." while a perfectly
// good household vault sat mounted two taps away in Settings. That is a refusal
// standing in for a question: the member said what they wanted, and the app
// answered by sending them somewhere else to configure a preference.
//
// So the pointer is asked for HERE, once, the first time it is needed. Choosing
// writes `frame.shareTarget` (the same record `ShareTargetSection` edits in
// Settings — one pointer, two ways in) and the share proceeds immediately.
// Nothing about this sheet is Photos-specific; any app's share control can open
// it, which is why it lives beside the pointer rather than beside a shelf.

import React from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";

import { Text } from "../components/NativeText";
import TopSafeArea from "../components/TopSafeArea";
import { borders, radii, spacing, t, useTheme } from "../theme";
import type { ShareTargetCandidate } from "./use-share-target";

export default function ShareTargetPicker({
  visible,
  candidates,
  onChoose,
  onClose,
}: {
  visible: boolean;
  candidates: readonly ShareTargetCandidate[];
  /** Called with the chosen vault. The caller persists and then proceeds. */
  onChoose: (vaultId: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={[styles.title, { color: colors.text }]}>
              Where should your shares go?
            </Text>
            <Text style={[styles.copy, { color: colors.textSoft }]}>
              A photograph is shared because it sits somewhere shared, and it
              stops being shared the moment it leaves. Pick that place once —
              you can change it in Settings later.
            </Text>
          </View>
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            onPress={onClose}
          >
            <Text style={{ color: colors.accent }}>Cancel</Text>
          </Pressable>
        </View>
        {candidates.map((candidate) => (
          <Pressable
            accessibilityLabel={candidate.label}
            accessibilityRole="button"
            key={candidate.vaultId}
            onPress={() => onChoose(candidate.vaultId)}
            style={[styles.row, { borderBottomColor: colors.line }]}
          >
            <Text style={[styles.rowLabel, { color: colors.text }]}>
              {candidate.label}
            </Text>
          </Pressable>
        ))}
      </TopSafeArea>
    </Modal>
  );
}

const styles = StyleSheet.create({
  copy: { ...t("small"), marginTop: spacing[1] },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  headerCopy: { flex: 1 },
  row: {
    borderBottomWidth: borders.hairline,
    borderRadius: radii.md,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: spacing[4],
  },
  rowLabel: t("body"),
  safe: { flex: 1 },
  title: t("title"),
});
