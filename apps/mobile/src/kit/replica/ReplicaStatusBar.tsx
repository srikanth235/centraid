import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { formatRelativeTime } from "@centraid/design";

import Icon from "../components/Icon";
import { family, radii, useTheme } from "../theme";
import { usePendingChanges } from "./pending-changes";
import { useReplica } from "./ReplicaProvider";

const DIVERGENCE_MS = 24 * 60 * 60 * 1_000;

/** Human status only: no cursor, epoch, replica, or internal storage jargon. */
export default function ReplicaStatusBar(): React.JSX.Element {
  const { colors } = useTheme();
  const {
    session,
    scopes = [],
    reachability = "device-offline",
    bootstrapProgress = [],
    refresh,
  } = useReplica();
  const [open, setOpen] = useState(false);
  // One AppState-gated ticker serves every mounted status bar; see
  // ./pending-changes.
  const { pending, refresh: refreshPending } = usePendingChanges(session);
  const updatedTimes = scopes.flatMap((scope) =>
    scope.updatedAt ? [Date.parse(scope.updatedAt)] : []
  );
  const newest = updatedTimes.length ? Math.max(...updatedTimes) : undefined;
  const oldest = updatedTimes.length ? Math.min(...updatedTimes) : undefined;
  const diverged =
    newest !== undefined &&
    oldest !== undefined &&
    newest - oldest >= DIVERGENCE_MS;
  const label = useMemo(() => {
    if (reachability === "device-offline") return "Offline on this phone";
    if (reachability === "gateway-asleep") return "Gateway asleep";
    if (reachability === "syncing") return "Syncing recent changes…";
    return newest
      ? `Updated ${formatRelativeTime(newest)}`
      : "Available offline";
  }, [newest, reachability]);
  const tint = reachability === "current" ? colors.accent : colors.danger;
  const action =
    reachability === "device-offline"
      ? "Check network"
      : reachability === "gateway-asleep"
        ? "Wake help"
        : reachability === "syncing"
          ? "Sync now"
          : "Refresh";
  const refreshReplica = (): void => {
    if (reachability !== "gateway-asleep") {
      void refresh?.();
      return;
    }
    Alert.alert(
      "Wake your gateway",
      "Open Centraid on your paired desktop and keep it online, then try again.",
      [
        { text: "Not now", style: "cancel" },
        { text: "Try again", onPress: () => void refresh?.() },
      ]
    );
  };
  const bootstrapLabel =
    bootstrapProgress.length === 0
      ? undefined
      : bootstrapProgress.length === 1
        ? bootstrapProgress[0]!.phase === "first-page"
          ? `${bootstrapProgress[0]!.vaultLabel}: recent items ready; older history syncing`
          : `${bootstrapProgress[0]!.vaultLabel}: ${bootstrapProgress[0]!.pages} pages ready; older history syncing`
        : `${bootstrapProgress.length} sources: recent items ready; older history syncing`;

  return (
    <>
      <View style={[styles.wrap, { borderColor: colors.line }]}>
        <View style={[styles.dot, { backgroundColor: tint }]} />
        <Text style={[styles.label, { color: colors.textSoft }]}>{label}</Text>
        <Pressable
          accessibilityLabel={action}
          disabled={!refresh}
          onPress={refreshReplica}
          style={styles.refresh}
        >
          {reachability === "syncing" ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : null}
          <Text style={[styles.refreshText, { color: colors.accent }]}>
            {action}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel={`Pending changes ${pending.length}`}
          onPress={() => {
            refreshPending();
            setOpen(true);
          }}
          style={[styles.pending, { backgroundColor: colors.bgSunken }]}
        >
          <Text style={[styles.pendingText, { color: colors.text }]}>
            Pending changes {pending.length}
          </Text>
          <Icon name="chevron-right" size={14} color={colors.textFaint} />
        </Pressable>
      </View>
      {bootstrapLabel ? (
        <View style={[styles.bootstrap, { backgroundColor: colors.bgSunken }]}>
          <Icon name="download-cloud" size={13} color={colors.accent} />
          <Text style={[styles.bootstrapText, { color: colors.textSoft }]}>
            {bootstrapLabel}
          </Text>
        </View>
      ) : null}
      {diverged ? (
        <View style={[styles.divergence, { backgroundColor: colors.bgSunken }]}>
          <View style={styles.divergenceHeading}>
            <Icon name="alert-circle" size={14} color={colors.danger} />
            <Text style={[styles.divergenceText, { color: colors.textSoft }]}>
              Sources last updated at different times.
            </Text>
          </View>
          {scopes.map((scope) => (
            <Text
              key={scope.vaultId}
              style={[styles.source, { color: colors.textFaint }]}
            >
              {scope.label}:{" "}
              {scope.updatedAt
                ? `updated ${formatRelativeTime(Date.parse(scope.updatedAt))}`
                : "not updated yet"}
            </Text>
          ))}
        </View>
      ) : null}
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <View style={[styles.sheet, { backgroundColor: colors.bg }]}>
          <View style={styles.sheetHeader}>
            <View>
              <Text style={[styles.title, { color: colors.text }]}>
                Pending changes
              </Text>
              <Text style={[styles.subtitle, { color: colors.textSoft }]}>
                Saved on this phone until each target accepts them
              </Text>
            </View>
            <Pressable onPress={() => setOpen(false)}>
              <Icon name="x" size={24} color={colors.text} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.list}>
            {pending.length === 0 ? (
              <Text style={[styles.empty, { color: colors.textSoft }]}>
                Nothing is waiting.
              </Text>
            ) : (
              pending.map((item) => {
                const terminal = ["failed", "denied", "executed"].includes(
                  item.status
                );
                return (
                  <View
                    key={`${item.kind}:${item.vaultId}:${item.id}`}
                    style={[
                      styles.card,
                      {
                        backgroundColor: colors.bgElev,
                        borderColor: colors.line,
                      },
                    ]}
                  >
                    <View style={styles.cardCopy}>
                      <Text style={[styles.cardTitle, { color: colors.text }]}>
                        {item.label}
                      </Text>
                      <Text
                        style={[styles.cardMeta, { color: colors.textSoft }]}
                      >
                        {item.vaultLabel} · {humanStatus(item.status)}
                      </Text>
                      {item.reason ? (
                        <Text style={[styles.reason, { color: colors.danger }]}>
                          {item.reason}
                        </Text>
                      ) : null}
                    </View>
                    <Pressable
                      onPress={() => {
                        if (terminal)
                          session?.dismissPendingChange(
                            item.id,
                            item.vaultId,
                            item.kind
                          );
                        else
                          void session
                            ?.cancelPendingChange(
                              item.id,
                              item.vaultId,
                              item.kind
                            )
                            .then(refreshPending);
                        refreshPending();
                      }}
                    >
                      <Text
                        style={[
                          styles.action,
                          {
                            color: terminal ? colors.textSoft : colors.danger,
                          },
                        ]}
                      >
                        {terminal ? "Dismiss" : "Cancel"}
                      </Text>
                    </Pressable>
                  </View>
                );
              })
            )}
            {scopes.map((scope) => (
              <Text
                key={scope.vaultId}
                style={[styles.source, { color: colors.textFaint }]}
              >
                {scope.label}:{" "}
                {scope.updatedAt
                  ? `updated ${formatRelativeTime(Date.parse(scope.updatedAt))}`
                  : "not updated yet"}
              </Text>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

function humanStatus(status: string): string {
  switch (status) {
    case "queued":
      return "waiting to send";
    case "sending":
    case "in-flight":
    case "awaiting-change":
      return "being applied";
    case "parked":
      return "needs attention";
    case "denied":
      return "permission changed";
    case "failed":
      return "could not apply";
    case "executed":
      return "complete";
    default:
      return status;
  }
}

const styles = StyleSheet.create({
  action: { fontFamily: family.sansBold, fontSize: 12 },
  card: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    padding: 14,
  },
  cardCopy: { flex: 1 },
  cardMeta: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 3 },
  cardTitle: { fontFamily: family.sansBold, fontSize: 14 },
  bootstrap: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  bootstrapText: {
    flex: 1,
    fontFamily: family.sansRegular,
    fontSize: 11,
  },
  divergence: {
    gap: 7,
    marginHorizontal: 14,
    padding: 8,
  },
  divergenceHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7,
  },
  divergenceText: { flex: 1, fontFamily: family.sansRegular, fontSize: 11 },
  dot: { borderRadius: 4, height: 7, width: 7 },
  empty: {
    fontFamily: family.sansRegular,
    fontSize: 14,
    paddingVertical: 40,
    textAlign: "center",
  },
  label: { flex: 1, fontFamily: family.sansRegular, fontSize: 11 },
  list: { gap: 10, padding: 18 },
  pending: {
    alignItems: "center",
    borderRadius: 999,
    flexDirection: "row",
    gap: 3,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  pendingText: { fontFamily: family.sansBold, fontSize: 10 },
  reason: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 6 },
  refresh: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    paddingVertical: 7,
  },
  refreshText: { fontFamily: family.sansBold, fontSize: 10 },
  sheet: { flex: 1 },
  sheetHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 18,
  },
  source: { fontFamily: family.sansRegular, fontSize: 10, marginTop: 4 },
  subtitle: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 3 },
  title: { fontFamily: family.sansBold, fontSize: 22 },
  wrap: {
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 7,
    minHeight: 36,
    paddingHorizontal: 14,
  },
});
