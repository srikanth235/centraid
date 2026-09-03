import React, { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";

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
import Tappable from "../components/Tappable";
import { borders, family, radii, t, useTheme } from "../theme";
import { usePendingChanges } from "./pending-changes";
import PendingChangesSheet from "./PendingChangesSheet";
import {
  replicaCoverageRow,
  replicaStatusRow,
  revokedNoticeRow,
} from "./replica-status";
import { useReplica } from "./ReplicaProvider";

const DIVERGENCE_MS = 24 * 60 * 60 * 1_000;

const TRANSFER_RULES_HINT = "Change these under Backup health in Settings.";

export default function ReplicaStatusBar(): React.JSX.Element {
  const { colors } = useTheme();
  const {
    session,
    scopes = [],
    reachability = "device-offline",
    bootstrapProgress = [],
    coverage,
    revokedNotices = [],
    dismissRevokedNotice,
    refresh,
    storageFull,
  } = useReplica();
  const [open, setOpen] = useState(false);
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
  const { label, action, actionable } = useMemo(
    () => replicaStatusRow(reachability),
    [reachability]
  );
  const coverageLabel = replicaCoverageRow({
    ...(coverage ? { coverage } : {}),
    bootstrapping: bootstrapProgress.length > 0,
  }).label;
  const tint = actionable ? colors.danger : colors.textFaint;
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

  if (storageFull) {
    return (
      <View style={styles.outOfRoomWrap}>
        <OutOfRoom
          cause={STORAGE_FULL_CAUSE}
          consequence={STORAGE_FULL_CONSEQUENCE}
          actionLabel={STORAGE_FULL_ACTION_LABEL}
          onAction={() => {
            clearPinnedThumbnailPacks();
            session?.resumeAfterStorageFull();
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
      {reachability === "sync-paused" ? (
        <View style={[styles.hint, { backgroundColor: colors.bgSunken }]}>
          <Text style={[styles.hintText, { color: colors.textSoft }]}>
            {TRANSFER_RULES_HINT}
          </Text>
        </View>
      ) : null}
      {revokedNotices.map((notice) => {
        const row = revokedNoticeRow(notice);
        return (
          <View
            key={notice.vaultId}
            style={[styles.hint, { backgroundColor: colors.bgSunken }]}
          >
            <Text style={[styles.hintText, { color: colors.textSoft }]}>
              {row.label}
            </Text>
            <Tappable
              accessibilityLabel={`${row.action} ${notice.label}`}
              onPress={() => dismissRevokedNotice?.(notice.vaultId)}
            >
              <Text style={[styles.refreshText, { color: colors.accent }]}>
                {row.action}
              </Text>
            </Tappable>
          </View>
        );
      })}
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
      {coverageLabel ? (
        <View style={[styles.bootstrap, { backgroundColor: colors.bgSunken }]}>
          <Icon name="download-cloud" size={13} color={colors.accent} />
          <Text style={[styles.bootstrapText, { color: colors.textSoft }]}>
            {coverageLabel}
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
      <PendingChangesSheet
        visible={open}
        onClose={() => setOpen(false)}
        pending={pending}
        scopes={scopes}
        actions={session}
        refresh={refreshPending}
      />
    </>
  );
}

const styles = StyleSheet.create({
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
    fontSize: t("control").fontSize,
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
  divergenceText: {
    flex: 1,
    fontFamily: family.sansRegular,
    fontSize: t("control").fontSize,
  },
  dot: { borderRadius: radii.sm, height: 7, width: 7 },
  hint: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7,
    marginHorizontal: 14,
    padding: 8,
  },
  hintText: {
    flex: 1,
    fontFamily: family.sansRegular,
    fontSize: t("control").fontSize,
  },
  label: {
    flex: 1,
    fontFamily: family.sansRegular,
    fontSize: t("control").fontSize,
  },
  pending: {
    alignItems: "center",
    borderRadius: radii.pill,
    flexDirection: "row",
    gap: 3,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  pendingText: { fontFamily: family.sansMedium, fontSize: t("mono").fontSize },
  refresh: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    paddingVertical: 7,
  },
  refreshText: { fontFamily: family.sansMedium, fontSize: t("mono").fontSize },
  source: {
    fontFamily: family.sansRegular,
    fontSize: t("mono").fontSize,
    marginTop: 4,
  },
  spacer: { flex: 1 },
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
