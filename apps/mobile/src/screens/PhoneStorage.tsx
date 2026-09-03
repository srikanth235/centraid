import { Directory, File, Paths } from "expo-file-system";
import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { formatBytes } from "@centraid/design";

import {
  pathToFileUri,
  replicaStorageDirectoryUri,
} from "../../modules/centraid-storage";
import Icon from "../kit/components/Icon";
import { Text } from "../kit/components/NativeText";
import TopSafeArea from "../kit/components/TopSafeArea";
import { useReplica } from "../kit/replica/ReplicaProvider";
import { density, family, metrics, radii, t, useTheme } from "../kit/theme";
import { getReplicaBackgroundRegistrationStatus } from "../lib/replica/background-sync";
import type { ReplicaBackgroundRegistrationStatus } from "../lib/replica/background-sync";
import {
  foldPendingUploadGroups,
  otherPhoneStorage,
  sqliteFamilyBytes,
} from "../lib/replica/storage-accounting";
import type { OtherPhoneStorage } from "../lib/replica/storage-accounting";
import {
  clearPinnedThumbnailPacks,
  thumbnailPackBytes,
  THUMBNAIL_SOURCE_BUDGET_BYTES,
} from "../lib/replica/thumbnail-pack";
import { UPLOAD_DB_NAME, UploadQueue } from "../lib/upload/native-queue";
import type { SettingsScreenProps } from "../navigation";

interface ScopeStorage {
  vaultId: string;
  label: string;
  databaseBytes: number;
  thumbnailBytes: number;
  pendingUploadBytes: number;
  pendingUploadCount: number;
}

const NO_OTHER_STORAGE: OtherPhoneStorage = {
  uploadLedgerBytes: 0,
  unmountedVaultBytes: 0,
  unmountedVaultCount: 0,
};

export default function PhoneStorage({
  navigation,
  route,
}: SettingsScreenProps<"PhoneStorage">): React.JSX.Element {
  const { colors } = useTheme();
  const { scopes = [], session, refresh: refreshReplica } = useReplica();
  const [background, setBackground] =
    useState<ReplicaBackgroundRegistrationStatus>();
  const [rows, setRows] = useState<ScopeStorage[]>([]);
  const [unassignedPendingBytes, setUnassignedPendingBytes] = useState(0);
  const [unassignedPendingCount, setUnassignedPendingCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingVideos, setPendingVideos] = useState(0);
  const [queueReadable, setQueueReadable] = useState(true);
  const [other, setOther] = useState<OtherPhoneStorage>(NO_OTHER_STORAGE);
  const [expandedVaultId, setExpandedVaultId] = useState<string>();
  const refresh = useCallback(() => {
    let totals = foldPendingUploadGroups([]);
    let queue: UploadQueue | undefined;
    try {
      queue = UploadQueue.open({
        gatewayBaseUrl: "http://127.0.0.1",
      });
      totals = foldPendingUploadGroups(queue.pendingStorageGroups());
      setQueueReadable(true);
    } catch {
      setQueueReadable(false);
    } finally {
      queue?.close();
    }
    setPendingCount(totals.total.itemCount);
    setPendingVideos(totals.videoCount);
    setUnassignedPendingBytes(totals.unassigned.bytes);
    setUnassignedPendingCount(totals.unassigned.itemCount);
    setRows(
      scopes.map((scope) => {
        const pending = totals.byVault.get(scope.vaultId);
        return {
          vaultId: scope.vaultId,
          label: scope.label,
          databaseBytes: sqliteFamilyBytes(scope.databaseName, fileBytes),
          thumbnailBytes: thumbnailPackBytes(scope.vaultId),
          pendingUploadBytes: pending?.bytes ?? 0,
          pendingUploadCount: pending?.itemCount ?? 0,
        };
      })
    );
    setOther(
      otherPhoneStorage(
        replicaDirectoryFiles(),
        scopes.map((scope) => scope.databaseName),
        UPLOAD_DB_NAME
      )
    );
  }, [scopes]);
  useEffect(() => {
    const timer = setTimeout(refresh, 0);
    return () => clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    void getReplicaBackgroundRegistrationStatus().then(
      (status) => {
        if (!cancelled && status) setBackground(status);
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const backgroundNotice = backgroundSyncNotice(background);
  const otherTotal = other.uploadLedgerBytes + other.unmountedVaultBytes;
  const total =
    unassignedPendingBytes +
    otherTotal +
    rows.reduce(
      (sum, row) =>
        sum + row.databaseBytes + row.thumbnailBytes + row.pendingUploadBytes,
      0
    );
  const databaseTotal = rows.reduce((sum, row) => sum + row.databaseBytes, 0);
  const thumbnailTotal = rows.reduce((sum, row) => sum + row.thumbnailBytes, 0);
  return (
    <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to Settings"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
          style={styles.back}
        >
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={[styles.title, { color: colors.text }]}>
            On this phone
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSoft }]}>
            <Text style={[t("mono"), { color: colors.textSoft }]}>
              {formatBytes(total)} used ·{" "}
              {formatBytes(Paths.availableDiskSpace)} free
            </Text>
          </Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {route.params?.signalCause ? (
          <View
            accessibilityLabel="Arrived from Notifications"
            accessibilityLiveRegion="polite"
            accessibilityRole="alert"
            style={[
              styles.attention,
              {
                backgroundColor: colors.bg,
                borderColor: colors.line,
                borderLeftColor: colors.attention,
              },
            ]}
          >
            <Text style={[styles.attentionTitle, { color: colors.text }]}>
              From Notifications
            </Text>
            <Text style={[styles.attentionBody, { color: colors.textSoft }]}>
              {route.params.signalCause}
            </Text>
          </View>
        ) : null}
        {!queueReadable || pendingCount > 0 ? (
          <View
            style={[
              styles.attention,
              {
                backgroundColor: colors.bg,
                borderColor: colors.line,
                borderLeftColor: colors.attention,
              },
            ]}
          >
            <Text style={[styles.attentionTitle, { color: colors.text }]}>
              {queueReadable
                ? pendingVideos > 0
                  ? `${pendingVideos} video${pendingVideos === 1 ? " exists" : "s exist"} here and nowhere else`
                  : `${pendingCount} item${pendingCount === 1 ? " exists" : "s exist"} here and nowhere else`
                : "Upload status could not be read"}
            </Text>
            <Text style={[styles.attentionBody, { color: colors.textSoft }]}>
              {queueReadable
                ? "These stay on this phone until their uploads finish."
                : "The upload ledger is still here — reopen this page after making room."}
            </Text>
          </View>
        ) : null}
        {backgroundNotice ? (
          <View
            style={[
              styles.attention,
              {
                backgroundColor: colors.bg,
                borderColor: colors.line,
                borderLeftColor: colors.attention,
              },
            ]}
          >
            <Text style={[styles.attentionTitle, { color: colors.text }]}>
              {backgroundNotice.title}
            </Text>
            <Text style={[styles.attentionBody, { color: colors.textSoft }]}>
              {backgroundNotice.body}
            </Text>
          </View>
        ) : null}
        <Text style={[styles.section, { color: colors.text }]}>
          Cache by vault
        </Text>
        {rows.map((row) => {
          const used =
            row.databaseBytes + row.thumbnailBytes + row.pendingUploadBytes;
          return (
            <View
              key={row.vaultId}
              style={[
                styles.card,
                { backgroundColor: colors.bgElev, borderColor: colors.line },
              ]}
            >
              <Pressable
                accessibilityLabel={`Storage breakdown for ${row.label}`}
                style={styles.cardHeader}
                onPress={() =>
                  setExpandedVaultId((current) =>
                    current === row.vaultId ? undefined : row.vaultId
                  )
                }
              >
                <Text style={[styles.cardTitle, { color: colors.text }]}>
                  {row.label}
                </Text>
                <Text style={[t("mono"), styles.total, { color: colors.text }]}>
                  {formatBytes(used)}
                </Text>
              </Pressable>
              {expandedVaultId === row.vaultId ? (
                <>
                  <StorageLine
                    label="Database · Docs, Photos & app metadata"
                    bytes={row.databaseBytes}
                    color={colors.textSoft}
                  />
                  <StorageLine
                    label={
                      <>
                        Offline thumbnails ·{" "}
                        <Text style={[t("mono"), { color: colors.textSoft }]}>
                          {formatBytes(THUMBNAIL_SOURCE_BUDGET_BYTES)}
                        </Text>{" "}
                        budget
                      </>
                    }
                    bytes={row.thumbnailBytes}
                    color={colors.textSoft}
                  />
                  <StorageLine
                    label={`Pending uploads · ${row.pendingUploadCount}`}
                    bytes={row.pendingUploadBytes}
                    color={colors.textSoft}
                  />
                </>
              ) : null}
            </View>
          );
        })}
        {unassignedPendingCount > 0 ? (
          <View
            style={[styles.explainer, { backgroundColor: colors.bgSunken }]}
          >
            <Icon name="alert-circle" size={18} color={colors.accent} />
            <Text style={[styles.explainerText, { color: colors.textSoft }]}>
              <Text style={[t("mono"), { color: colors.textSoft }]}>
                {formatBytes(unassignedPendingBytes)}
              </Text>{" "}
              across {unassignedPendingCount} pending upload
              {unassignedPendingCount === 1 ? " is" : "s are"} not assigned to a
              vault. They remain durable and are not assigned to whichever vault
              is currently focused.
            </Text>
          </View>
        ) : null}
        {otherTotal > 0 ? (
          <>
            <Text style={[styles.section, { color: colors.text }]}>
              Other Centraid data on this phone
            </Text>
            <View
              style={[
                styles.card,
                { backgroundColor: colors.bgElev, borderColor: colors.line },
              ]}
            >
              <StorageLine
                label="Upload ledger · the queue's own database"
                bytes={other.uploadLedgerBytes}
                color={colors.textSoft}
              />
              {other.unmountedVaultCount > 0 ? (
                <StorageLine
                  label={`Vault databases not currently mounted · ${other.unmountedVaultCount}`}
                  bytes={other.unmountedVaultBytes}
                  color={colors.textSoft}
                />
              ) : null}
            </View>
          </>
        ) : null}
        <Text style={[styles.section, { color: colors.text }]}>Room</Text>
        <View style={[styles.explainer, { backgroundColor: colors.bgSunken }]}>
          <Icon name="shield" size={18} color={colors.textSoft} />
          <Text style={[styles.explainerText, { color: colors.textSoft }]}>
            {formatBytes(Paths.availableDiskSpace)} free on this phone. Vault
            databases stay in protected storage. Thumbnail packs can download
            again; pending uploads cannot be cleared here.
          </Text>
        </View>
        <Text style={[styles.section, { color: colors.text }]}>
          Free up space
        </Text>
        <View
          style={[
            styles.card,
            { backgroundColor: colors.bgElev, borderColor: colors.line },
          ]}
        >
          <StorageLine
            label="Thumbnail packs · can clear"
            bytes={thumbnailTotal}
            color={colors.textSoft}
          />
          <StorageLine
            label="Vault databases · stay"
            bytes={databaseTotal}
            color={colors.textSoft}
          />
          <StorageLine
            label="Only-here uploads · cannot clear"
            bytes={
              unassignedPendingBytes +
              rows.reduce((sum, row) => sum + row.pendingUploadBytes, 0)
            }
            color={pendingCount > 0 ? colors.attention : colors.textSoft}
          />
          {otherTotal > 0 ? (
            <StorageLine
              label="Other Centraid data · stays"
              bytes={otherTotal}
              color={colors.textSoft}
            />
          ) : null}
        </View>
        <Pressable
          style={[styles.button, { borderColor: colors.line }]}
          onPress={() =>
            Alert.alert(
              "Free up offline thumbnails?",
              "This clears thumbnail packs only. Vault databases and pending uploads stay; only-here videos cannot be cleared.",
              [
                { text: "Cancel" },
                {
                  text: "Free up",
                  style: "destructive",
                  onPress: () => {
                    clearPinnedThumbnailPacks();
                    session?.resumeAfterStorageFull();
                    void refreshReplica?.();
                    refresh();
                  },
                },
              ]
            )
          }
        >
          <Icon name="trash-2" size={18} color={colors.text} />
          <Text style={[styles.buttonText, { color: colors.text }]}>
            Free up thumbnail packs
          </Text>
        </Pressable>
      </ScrollView>
    </TopSafeArea>
  );
}

function StorageLine({
  label,
  bytes,
  color,
}: {
  label: React.ReactNode;
  bytes: number;
  color: string;
}): React.JSX.Element {
  return (
    <View style={styles.line}>
      <Text style={[styles.lineLabel, { color }]}>{label}</Text>
      <Text style={[t("mono"), styles.lineValue, { color }]}>
        {formatBytes(bytes)}
      </Text>
    </View>
  );
}

function backgroundSyncNotice(
  status: ReplicaBackgroundRegistrationStatus | undefined
): { title: string; body: string } | undefined {
  if (!status) return undefined;
  if (status.availability === "restricted")
    return {
      title: "Background App Refresh is off",
      body: "Turn it back on in Settings to sync while Centraid is closed.",
    };
  if (status.backgroundTask.registered && status.pushTask.registered)
    return undefined;
  return {
    title: "Background sync did not register",
    body:
      status.backgroundTask.reason ??
      status.pushTask.reason ??
      "This phone syncs while you have Centraid open.",
  };
}

function fileBytes(path: string): number {
  const file = new File(pathToFileUri(path));
  return file.exists ? file.size : 0;
}

function replicaDirectoryFiles(): { name: string; size: number }[] {
  const root = replicaStorageDirectoryUri();
  if (!root) return [];
  const directory = new Directory(root);
  if (!directory.exists) return [];
  return directory
    .list()
    .flatMap((entry) =>
      entry instanceof File ? [{ name: entry.name, size: entry.size }] : []
    );
}

const styles = StyleSheet.create({
  attention: {
    borderLeftWidth: 2,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: 8,
    padding: density.comfortable.pad,
  },
  attentionBody: { ...t("body") },
  attentionTitle: { ...t("bodyStrong") },
  body: { gap: 14, padding: 18 },
  back: {
    alignItems: "center",
    height: metrics.row,
    justifyContent: "center",
    width: metrics.row,
  },
  button: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: 9,
    justifyContent: "center",
    padding: 14,
  },
  buttonText: { fontFamily: family.sansMedium, fontSize: t("mono").fontSize },
  card: {
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: 10,
    padding: density.comfortable.pad,
  },
  cardHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: metrics.row,
  },
  cardTitle: { fontFamily: family.sansMedium, fontSize: t("reading").fontSize },
  explainer: {
    alignItems: "flex-start",
    borderRadius: radii.md,
    flexDirection: "row",
    gap: 10,
    padding: 14,
  },
  explainerText: {
    flex: 1,
    ...t("small"),
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    padding: 18,
  },
  headerCopy: { flex: 1 },
  line: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  lineLabel: {
    flex: 1,
    fontFamily: family.sansRegular,
    fontSize: t("mono").fontSize,
  },
  lineValue: { fontFamily: family.sansMedium, fontSize: t("mono").fontSize },
  safe: { flex: 1 },
  section: { ...t("bodyStrong"), marginTop: 4 },
  subtitle: {
    fontFamily: family.sansRegular,
    fontSize: t("mono").fontSize,
    marginTop: 2,
  },
  title: { fontFamily: family.sansMedium, fontSize: t("title").fontSize },
  total: { fontFamily: family.sansMedium, fontSize: t("body").fontSize },
});
