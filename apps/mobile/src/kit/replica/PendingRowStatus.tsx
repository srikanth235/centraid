import React from "react";
import { Pressable, View } from "react-native";

import {
  pendingOverlayCanDiscard,
  pendingOverlayCanRetry,
  pendingOverlayCopy,
  readPendingOverlay,
} from "@centraid/blueprints/apps/_shared/pending-overlay";

import { rootNavigationRef } from "../../navigation";
import { Text } from "../components/NativeText";
import { postStatus } from "../components/status-line";
import { radii, t, useTheme } from "../theme";
import { useReplica } from "./ReplicaProvider";

export default function PendingRowStatus({
  row,
  onEdit,
}: {
  row: Readonly<Record<string, unknown>>;
  onEdit?: () => void;
}): React.JSX.Element | null {
  const { colors } = useTheme();
  const { session } = useReplica();
  const pending = readPendingOverlay(row);
  if (!pending) return null;
  const vaultId =
    typeof row.__centraidScopeId === "string"
      ? row.__centraidScopeId
      : undefined;
  const retry = async (): Promise<void> => {
    const result = await session?.retryPendingWrite(pending.key, vaultId);
    postStatus(
      result ? "Change queued again." : "This change is no longer retryable."
    );
  };
  const discard = async (): Promise<void> => {
    const result = await session?.discardPendingWrite(pending.key, vaultId);
    postStatus(
      result ? "Pending change discarded." : "This change has already settled."
    );
  };
  const review = (): void => {
    if (rootNavigationRef.isReady())
      rootNavigationRef.navigate("Settings", { screen: "Approvals" });
  };

  return (
    <View style={{ gap: 4, marginTop: 4 }}>
      <View
        accessible
        accessibilityLabel={`Pending change: ${pendingOverlayCopy(pending)}`}
        style={{
          alignSelf: "flex-start",
          backgroundColor: colors.bgSunken,
          borderRadius: radii.pill,
          paddingHorizontal: 9,
          paddingVertical: 5,
        }}
      >
        <Text style={[t("small"), { color: colors.textSoft }]}>
          {pending.status}
        </Text>
      </View>
      {pending.status === "sending" ? null : (
        <Text style={[t("small"), { color: colors.textSoft }]}>
          {pendingOverlayCopy(pending)}
        </Text>
      )}
      {pending.status === "parked" ? (
        <Pressable accessibilityRole="button" onPress={review}>
          <Text style={[t("small"), { color: colors.accent }]}>
            Review in Approvals
          </Text>
        </Pressable>
      ) : null}
      {pendingOverlayCanRetry(pending) || pendingOverlayCanDiscard(pending) ? (
        <View style={{ flexDirection: "row", gap: 12 }}>
          {pendingOverlayCanRetry(pending) ? (
            <Pressable accessibilityRole="button" onPress={() => void retry()}>
              <Text style={{ color: colors.accent }}>Retry</Text>
            </Pressable>
          ) : null}
          {onEdit ? (
            <Pressable accessibilityRole="button" onPress={onEdit}>
              <Text style={{ color: colors.accent }}>Edit</Text>
            </Pressable>
          ) : null}
          {pendingOverlayCanDiscard(pending) ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void discard()}
            >
              <Text style={{ color: colors.textSoft }}>Discard</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
