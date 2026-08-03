import React from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useReplica } from "../replica/ReplicaProvider";
import { family, radii, useTheme } from "../theme";
import { Text } from "./NativeText";
import { postStatus } from "./status-line";

export default function AudiencePlacementSheet({
  visible,
  itemType,
  itemId,
  sourceVaultId,
  noun,
  onClose,
}: {
  visible: boolean;
  itemType: "core.collection" | "core.document" | "locker.item" | "tally.group";
  itemId: string;
  sourceVaultId: string;
  noun: string;
  onClose: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const replica = useReplica();
  const targets = (replica.scopes ?? []).filter(
    (scope) => scope.vaultId !== sourceVaultId && scope.role !== "read"
  );
  const place = async (targetVaultId: string): Promise<void> => {
    if (!replica.session) return;
    try {
      const result = await replica.session.place({
        kind: "add",
        itemType,
        itemId,
        sourceVaultId,
        targetVaultId,
      });
      onClose();
      postStatus(
        result.status === "executed"
          ? `${noun} shared — the audience copy and access receipt are saved.`
          : `${noun} share queued — it will sync when the gateway reconnects.`
      );
    } catch (error) {
      postStatus(
        `Could not share: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
        <View style={styles.header}>
          <View>
            <Text style={[styles.title, { color: colors.text }]}>
              Share {noun.toLowerCase()}
            </Text>
            <Text style={[styles.copy, { color: colors.textSoft }]}>
              Choose a household audience. Read-only audiences are not shown.
            </Text>
          </View>
          <Pressable
            accessibilityLabel="Close household audience picker"
            accessibilityRole="button"
            onPress={onClose}
          >
            <Text style={{ color: colors.accent }}>Done</Text>
          </Pressable>
        </View>
        {targets.length === 0 ? (
          <Text style={[styles.empty, { color: colors.textSoft }]}>
            No writable household audience is available. An admin can invite
            members and grant a vault role from Household settings.
          </Text>
        ) : (
          targets.map((scope) => (
            <Pressable
              accessibilityLabel={`Share ${noun} with ${scope.label}`}
              accessibilityRole="button"
              key={scope.vaultId}
              onPress={() => void place(scope.vaultId)}
              style={[
                styles.row,
                { backgroundColor: colors.bgElev, borderColor: colors.line },
              ]}
            >
              <Text style={[styles.rowTitle, { color: colors.text }]}>
                {scope.label}
              </Text>
              <Text style={[styles.role, { color: colors.textFaint }]}>
                {scope.role}
              </Text>
            </Pressable>
          ))
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, padding: 20, gap: 12 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 8,
  },
  title: { fontFamily: family.sansMedium, fontSize: 25 },
  copy: { marginTop: 5, maxWidth: 300, lineHeight: 20 },
  row: {
    minHeight: 58,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  rowTitle: { fontWeight: "700", fontSize: 16 },
  role: { textTransform: "capitalize" },
  empty: { lineHeight: 22, paddingVertical: 18 },
});
