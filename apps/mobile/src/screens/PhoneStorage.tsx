import { File } from "expo-file-system";
import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { formatBytes } from "@centraid/design";

import Icon from "../kit/components/Icon";
import { Text } from "../kit/components/NativeText";
import { useReplica } from "../kit/replica/ReplicaProvider";
import { family, radii, useTheme } from "../kit/theme";
import {
  pendingBytesByVault,
  sqliteFamilyBytes,
} from "../lib/replica/storage-accounting";
import {
  clearPinnedThumbnailPacks,
  thumbnailPackBytes,
  THUMBNAIL_SOURCE_BUDGET_BYTES,
} from "../lib/replica/thumbnail-pack";
import { UploadQueue } from "../lib/upload/native-queue";
import type { SettingsScreenProps } from "../navigation";

interface ScopeStorage {
  vaultId: string;
  label: string;
  databaseBytes: number;
  thumbnailBytes: number;
  pendingUploadBytes: number;
}

export default function PhoneStorage({
  navigation,
}: SettingsScreenProps<"PhoneStorage">): React.JSX.Element {
  const { colors } = useTheme();
  const { scopes = [] } = useReplica();
  const [rows, setRows] = useState<ScopeStorage[]>([]);
  const [unassignedPendingBytes, setUnassignedPendingBytes] = useState(0);
  const [expandedVaultId, setExpandedVaultId] = useState<string>();
  const refresh = useCallback(() => {
    let pending = { byVault: new Map<string, number>(), unassigned: 0 };
    let queue: UploadQueue | undefined;
    try {
      queue = UploadQueue.open({
        gatewayBaseUrl: "http://127.0.0.1",
      });
      pending = pendingBytesByVault(queue.pending());
    } catch {
      // A busy upload writer is transient; next focus/refresh fills it in.
    } finally {
      queue?.close();
    }
    setUnassignedPendingBytes(pending.unassigned);
    setRows(
      scopes.map((scope) => {
        return {
          vaultId: scope.vaultId,
          label: scope.label,
          databaseBytes: sqliteFamilyBytes(scope.databaseName, fileBytes),
          thumbnailBytes: thumbnailPackBytes(scope.vaultId),
          pendingUploadBytes: pending.byVault.get(scope.vaultId) ?? 0,
        };
      })
    );
  }, [scopes]);
  useEffect(() => {
    const timer = setTimeout(refresh, 0);
    return () => clearTimeout(timer);
  }, [refresh]);
  const total =
    unassignedPendingBytes +
    rows.reduce(
      (sum, row) =>
        sum + row.databaseBytes + row.thumbnailBytes + row.pendingUploadBytes,
      0
    );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()}>
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={[styles.title, { color: colors.text }]}>
            Phone storage
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSoft }]}>
            {formatBytes(total)} used by offline data
          </Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
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
                <Text style={[styles.total, { color: colors.text }]}>
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
                    label={`Offline thumbnails · ${formatBytes(THUMBNAIL_SOURCE_BUDGET_BYTES)} budget`}
                    bytes={row.thumbnailBytes}
                    color={colors.textSoft}
                  />
                  <StorageLine
                    label="Pending uploads"
                    bytes={row.pendingUploadBytes}
                    color={colors.textSoft}
                  />
                </>
              ) : null}
            </View>
          );
        })}
        {unassignedPendingBytes > 0 ? (
          <View
            style={[styles.explainer, { backgroundColor: colors.bgSunken }]}
          >
            <Icon name="alert-circle" size={18} color={colors.accent} />
            <Text style={[styles.explainerText, { color: colors.textSoft }]}>
              {formatBytes(unassignedPendingBytes)} of pending uploads are not
              assigned to a vault. They remain durable and are not assigned to
              whichever vault is currently focused.
            </Text>
          </View>
        ) : null}
        <View style={[styles.explainer, { backgroundColor: colors.bgSunken }]}>
          <Icon name="shield" size={18} color={colors.accent} />
          <Text style={[styles.explainerText, { color: colors.textSoft }]}>
            Databases live in protected app storage, survive cache eviction, and
            are excluded from iCloud Backup and Android Auto Backup. Originals
            are never counted as cache because they stay on demand.
          </Text>
        </View>
        <Pressable
          style={[styles.button, { borderColor: colors.line }]}
          onPress={() =>
            Alert.alert(
              "Free up offline thumbnails?",
              "Databases and pending uploads stay. Thumbnails download again under the same per-vault budget.",
              [
                { text: "Cancel" },
                {
                  text: "Free up",
                  style: "destructive",
                  onPress: () => {
                    clearPinnedThumbnailPacks();
                    refresh();
                  },
                },
              ]
            )
          }
        >
          <Icon name="trash-2" size={18} color={colors.danger} />
          <Text style={[styles.buttonText, { color: colors.danger }]}>
            Free up thumbnail cache
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function StorageLine({
  label,
  bytes,
  color,
}: {
  label: string;
  bytes: number;
  color: string;
}): React.JSX.Element {
  return (
    <View style={styles.line}>
      <Text style={[styles.lineLabel, { color }]}>{label}</Text>
      <Text style={[styles.lineValue, { color }]}>{formatBytes(bytes)}</Text>
    </View>
  );
}

function fileBytes(path: string): number {
  const file = new File(path);
  return file.exists ? file.size : 0;
}

const styles = StyleSheet.create({
  body: { gap: 14, padding: 18 },
  button: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: 9,
    justifyContent: "center",
    padding: 14,
  },
  buttonText: { fontFamily: family.sansBold, fontSize: 13 },
  card: { borderRadius: radii.lg, borderWidth: 1, gap: 10, padding: 16 },
  cardHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  cardTitle: { fontFamily: family.sansBold, fontSize: 17 },
  explainer: {
    alignItems: "flex-start",
    borderRadius: radii.md,
    flexDirection: "row",
    gap: 10,
    padding: 14,
  },
  explainerText: {
    flex: 1,
    fontFamily: family.sansRegular,
    fontSize: 12,
    lineHeight: 18,
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
  lineLabel: { flex: 1, fontFamily: family.sansRegular, fontSize: 12 },
  lineValue: { fontFamily: family.sansMedium, fontSize: 12 },
  safe: { flex: 1 },
  subtitle: { fontFamily: family.sansRegular, fontSize: 12, marginTop: 2 },
  title: { fontFamily: family.sansBold, fontSize: 23 },
  total: { fontFamily: family.sansBold, fontSize: 14 },
});
