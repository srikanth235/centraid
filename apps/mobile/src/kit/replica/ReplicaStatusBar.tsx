import React, { useMemo, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";

import { formatRelativeTime } from "@centraid/design";

import {
  STORAGE_FULL_ACTION_LABEL,
  STORAGE_FULL_CAUSE,
  STORAGE_FULL_CONSEQUENCE,
} from "../../lib/replica/replica-storage-error";
import { clearPinnedThumbnailPacks } from "../../lib/replica/thumbnail-pack";
import Icon from "../components/Icon";
import { Text } from "../components/NativeText";
import OutOfRoom from "../components/OutOfRoom";
import { borders, family, radii, t, useTheme } from "../theme";
import { usePendingChanges } from "./pending-changes";
import { replicaStatusRow } from "./replica-status";
import { useReplica } from "./ReplicaProvider";

const DIVERGENCE_MS = 24 * 60 * 60 * 1_000;

/**
 * Human status only: no cursor, epoch, replica, or internal storage jargon.
 *
 * **It says nothing when there is nothing wrong.** This bar mounts on roughly
 * twenty app screens, and in the settled case it drew a permanent row reading
 * `Updated 10m ago` with a `Refresh` button on the other end — above Photos'
 * own count, above the first photograph. Neither half earned that row:
 *
 *  - **Refresh** is the third way to do the same thing. Every screen carrying
 *    this bar scrolls, and pull-to-refresh is the gesture a phone already has;
 *    a labelled button for it is a control that exists because the desktop had
 *    one. The action label is kept for the states where the gesture would NOT
 *    help — a sleeping gateway needs waking, not pulling — and those states are
 *    the only ones that still render it.
 *  - **Updated 10m ago** is a fact about the vault, not about Photos, and the
 *    vault has one screen: Home already carries an ambient line saying how much
 *    is in it and whether the gateway is answering
 *    (screens/home/HomeStatusLine.tsx). Repeating a per-route copy of it made
 *    freshness look like something each app owns separately.
 *
 * So `current` renders no row at all. Everything that is genuinely worth
 * interrupting a member for — offline, asleep, syncing, first-sync progress,
 * sources disagreeing by a day, pending changes, out of room — still renders
 * exactly as before, and now has the row to itself.
 */
export default function ReplicaStatusBar(): React.JSX.Element {
  const { colors } = useTheme();
  const {
    session,
    scopes = [],
    reachability = "device-offline",
    bootstrapProgress = [],
    refresh,
    storageFull,
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
  // The replica bar's copy lives in a pure module, tested independently.
  const { label, action, actionable } = useMemo(
    () => replicaStatusRow(reachability),
    [reachability]
  );
  // Red when the member can act on it, neutral when they are waiting.
  const tint = actionable ? colors.danger : colors.textFaint;
  const refreshReplica = (): void => {
    // Wake-help is gated to gateway-asleep; other actions use pull-to-refresh.
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
  // `pages` and the source count are real numerics — mono and tabular, per
  // the ramp's "numerics are mono and tabular in every app, without
  // exception" — so the sentence is split around the number rather than
  // interpolated into one plain string.
  const bootstrap:
    | { prefix: string; count?: number; suffix: string }
    | undefined =
    bootstrapProgress.length === 0
      ? undefined
      : bootstrapProgress.length === 1
        ? bootstrapProgress[0]!.phase === "first-page"
          ? {
              prefix: `${bootstrapProgress[0]!.vaultLabel}: `,
              suffix: "recent items ready; older history syncing",
            }
          : {
              prefix: `${bootstrapProgress[0]!.vaultLabel}: `,
              count: bootstrapProgress[0]!.pages,
              suffix: " pages ready; older history syncing",
            }
        : {
            prefix: "",
            count: bootstrapProgress.length,
            suffix: " sources: recent items ready; older history syncing",
          };

  // `out of room` pre-empts the normal status row: the reachability/bootstrap
  // language above ("Offline", "Syncing…") is about network state, not disk
  // state, and would be a second, contradicting explanation for the same
  // paused sync.
  if (storageFull) {
    return (
      <View style={styles.outOfRoomWrap}>
        <OutOfRoom
          cause={STORAGE_FULL_CAUSE}
          consequence={STORAGE_FULL_CONSEQUENCE}
          actionLabel={STORAGE_FULL_ACTION_LABEL}
          onAction={() => {
            clearPinnedThumbnailPacks();
            void refresh?.();
          }}
        />
      </View>
    );
  }

  return (
    <>
      {/* When `label` is undefined, render nothing for this state (offline is
          one such state). The row is conditional in its entirety unless pending
          changes exist. */}
      {label || pending.length > 0 ? (
        <View style={[styles.wrap, { borderColor: colors.line }]}>
          {label ? (
            <>
              <View style={[styles.dot, { backgroundColor: tint }]} />
              <Text style={[styles.label, { color: colors.textSoft }]}>
                {label}
              </Text>
            </>
          ) : (
            // Nothing to say, but something to show: the chip keeps the
            // trailing edge it has whenever a label is present.
            <View style={styles.spacer} />
          )}
          {action ? (
            <Pressable
              accessibilityLabel={action}
              disabled={!refresh}
              onPress={refreshReplica}
              style={styles.refresh}
            >
              {/* No spinning glyph while syncing — the label above already says
                  "Syncing recent changes…", and the bootstrap line below carries
                  the one exact count this operation actually has. */}
              <Text style={[styles.refreshText, { color: colors.accent }]}>
                {action}
              </Text>
            </Pressable>
          ) : null}
          {/* A standing badge at zero is exactly what §18 forbids — "0 pending
              changes" is not information a member needs to see permanently, so
              this chip renders only once there is something to report. */}
          {pending.length > 0 ? (
            <Pressable
              accessibilityLabel={`Pending changes ${pending.length}`}
              onPress={() => {
                refreshPending();
                setOpen(true);
              }}
              style={[styles.pending, { backgroundColor: colors.bgSunken }]}
            >
              <Text style={[styles.pendingText, { color: colors.text }]}>
                Pending changes{" "}
                <Text style={[t("mono"), { color: colors.text }]}>
                  {pending.length.toLocaleString()}
                </Text>
              </Text>
              <Icon name="chevron-right" size={14} color={colors.textFaint} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {bootstrap ? (
        <View style={[styles.bootstrap, { backgroundColor: colors.bgSunken }]}>
          <Icon name="download-cloud" size={13} color={colors.accent} />
          <Text style={[styles.bootstrapText, { color: colors.textSoft }]}>
            {bootstrap.prefix}
            {bootstrap.count === undefined ? null : (
              <Text style={[t("mono"), { color: colors.textSoft }]}>
                {bootstrap.count.toLocaleString()}
              </Text>
            )}
            {bootstrap.suffix}
          </Text>
        </View>
      ) : null}
      {diverged ? (
        <View style={[styles.divergence, { backgroundColor: colors.bgSunken }]}>
          {/* A non-alarming fact — sources settle at different times, which
              is expected of a multi-vault replica, not a fault — so this
              carries no alarm glyph, matching the no-icon banner grammar
              (:4867-4873) rather than a danger-tinted alert-circle. */}
          <View style={styles.divergenceHeading}>
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
  action: { fontFamily: family.sansMedium, fontSize: 12 },
  card: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    flexDirection: "row",
    gap: 12,
    padding: 14,
  },
  cardCopy: { flex: 1 },
  cardMeta: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 3 },
  cardTitle: { fontFamily: family.sansMedium, fontSize: 14 },
  outOfRoomWrap: { padding: 14 },
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
  pendingText: { fontFamily: family.sansMedium, fontSize: 13 },
  reason: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 6 },
  refresh: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    paddingVertical: 7,
  },
  refreshText: { fontFamily: family.sansMedium, fontSize: 13 },
  sheet: { flex: 1 },
  sheetHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 18,
  },
  source: { fontFamily: family.sansRegular, fontSize: 13, marginTop: 4 },
  spacer: { flex: 1 },
  subtitle: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 3 },
  title: { fontFamily: family.sansMedium, fontSize: 22 },
  wrap: {
    alignItems: "center",
    borderBottomWidth: borders.hairline,
    borderTopWidth: borders.hairline,
    flexDirection: "row",
    gap: 7,
    minHeight: 36,
    paddingHorizontal: 14,
  },
});
