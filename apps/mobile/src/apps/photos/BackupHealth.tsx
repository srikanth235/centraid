import { Feather } from "@expo/vector-icons";
import { File } from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import React, { useEffect, useMemo, useState } from "react";
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import { useTheme } from "../../kit/theme";
import { authHeader } from "../../lib/gateway";
import { backupDeviceMedia } from "../../lib/upload/media-producer";
import {
  LAST_SUCCESSFUL_SYNC_KEY,
  nativeUploadPolicy,
} from "../../lib/upload/native-policy";
import { UploadQueue } from "../../lib/upload/native-queue";
import type { PhotosScreenProps } from "../../navigation";
import { Store } from "../../storage";
import { styles } from "./BackupHealth.styles";
import {
  IN_CLOUD_MESSAGE,
  InCloudOriginalError,
  capturedAtIso,
  durationSeconds,
  liveVideoUri,
  openDeviceOriginal,
} from "./device-media";
import type { DeviceOriginal } from "./device-media";

interface Rules {
  wifiOnly: boolean;
  allowMetered: boolean;
  chargerOnly: boolean;
  selectedAlbums: string[];
}
const RULES_KEY = "photos.backupRules";
const DEFAULT_RULES: Rules = {
  wifiOnly: true,
  allowMetered: false,
  chargerOnly: false,
  selectedAlbums: [],
};

type PendingUpload = {
  plaintextSize: number;
  lastError?: string;
  filename?: string;
};

// A one-shot read of the durable upload queue — an external system, opened and
// closed around the read so the screen never holds the sqlite handle. Lives
// outside the component so the effect that calls it stays a plain external read
// rather than an in-body state update.
function readPendingUploads(
  gatewayBase: string,
  setPending: (next: PendingUpload[]) => void
): void {
  const queue = UploadQueue.open({
    gatewayBaseUrl: gatewayBase,
    headers: authHeader,
  });
  setPending(queue.pending());
  queue.close();
}

export default function BackupHealth({
  navigation,
}: PhotosScreenProps<"BackupHealth">): React.JSX.Element {
  const { colors } = useTheme();
  const { gatewayBase, online, session } = useReplica();
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  // Album titles are async getters in the Next API, so they are read once here
  // rather than during render. The asset count legacy albums carried has no
  // Next equivalent short of walking every album, which this screen will not do.
  const [albums, setAlbums] = useState<Array<{ id: string; title: string }>>(
    []
  );
  const [albumError, setAlbumError] = useState<string>();
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [storage, setStorage] = useState("Storage policy unavailable offline");
  const [running, setRunning] = useState(false);
  const [inCloudSkipped, setInCloudSkipped] = useState(0);
  const [lastSuccessfulSync, setLastSuccessfulSync] = useState<string>();

  useEffect(() => {
    void Store.hydrate(RULES_KEY, DEFAULT_RULES).then((value) =>
      setRules({ ...DEFAULT_RULES, ...value })
    );
    void Store.hydrate<string | undefined>(
      LAST_SUCCESSFUL_SYNC_KEY,
      undefined
    ).then(setLastSuccessfulSync);
    void MediaLibrary.Album.getAll()
      .then((all) =>
        Promise.all(
          all.map(async (album) => ({
            id: album.id,
            title: await album.getTitle(),
          }))
        )
      )
      .then(setAlbums)
      .catch((error: unknown) =>
        setAlbumError(error instanceof Error ? error.message : String(error))
      );
  }, []);
  useEffect(() => {
    if (!gatewayBase) return;
    readPendingUploads(gatewayBase, setPending);
    if (online)
      void fetch(`${gatewayBase}/centraid/_gateway/storage/status`, {
        headers: authHeader(),
      })
        .then((response) => response.json())
        .then(
          (body: {
            vaults?: Array<{
              casAck?: string;
              backlog?: { count: number; bytes: number };
              replicated?: { count: number; bytes: number };
            }>;
          }) => {
            const vault = body.vaults?.[0];
            if (vault)
              setStorage(
                `${vault.replicated?.count ?? 0} replicated · ${vault.backlog?.count ?? 0} offsite · policy ${vault.casAck ?? "unknown"}`
              );
          }
        )
        .catch(() => undefined);
  }, [gatewayBase, online]);

  const bytes = useMemo(
    () => pending.reduce((sum, item) => sum + item.plaintextSize, 0),
    [pending]
  );
  const update = (next: Rules): void => {
    setRules(next);
    Store.set(RULES_KEY, next);
  };
  const backupAlbums = async (): Promise<void> => {
    if (!session || !gatewayBase || rules.selectedAlbums.length === 0) return;
    if (!(await nativeUploadPolicy().canTransfer())) return;
    setRunning(true);
    let skipped = 0;
    setInCloudSkipped(0);
    try {
      const pageSize = 250;
      const backupAsset = async (
        metadata: MediaLibrary.AssetMetadata
      ): Promise<void> => {
        const isVideo = metadata.mediaType === MediaLibrary.MediaType.VIDEO;
        const capturedAt = capturedAtIso(metadata);
        let original: DeviceOriginal;
        try {
          original = await openDeviceOriginal(metadata.id);
        } catch (error) {
          if (!(error instanceof InCloudOriginalError)) throw error;
          // Counted and shown on the screen, never passed over in silence.
          skipped += 1;
          setInCloudSkipped(skipped);
          return;
        }
        // Resolved before the still so both halves share one capture group.
        const companion = await liveVideoUri(original.asset);
        await backupDeviceMedia(session, gatewayBase, {
          localUri: original.uri,
          ...(metadata.filename ? { filename: metadata.filename } : {}),
          mediaType: isVideo ? "video/mp4" : "image/jpeg",
          plaintextSize: new File(original.uri).size,
          kind: isVideo ? "video" : "photo",
          capturedAt,
          captureGroupId: companion ? `live:${metadata.id}` : undefined,
          width: metadata.width ?? undefined,
          height: metadata.height ?? undefined,
          durationS: durationSeconds(metadata.duration),
        });
        if (companion) {
          const companionFile = new File(companion);
          await backupDeviceMedia(session, gatewayBase, {
            localUri: companion,
            // The Next API extracts the Live Photo's video to a file rather
            // than exposing a paired asset, so its dimensions and duration
            // are not on offer — only the name and the bytes.
            filename: companionFile.name,
            mediaType: "video/quicktime",
            plaintextSize: companionFile.size,
            kind: "video",
            capturedAt,
            captureGroupId: `live:${metadata.id}`,
          });
        }
      };
      const backupAlbumPage = async (
        albumId: string,
        offset: number
      ): Promise<void> => {
        // One native round-trip per page for every cheap field; the bytes of
        // each asset are resolved individually below.
        const page = await new MediaLibrary.Query()
          .album(new MediaLibrary.Album(albumId))
          .within(MediaLibrary.AssetField.MEDIA_TYPE, [
            MediaLibrary.MediaType.IMAGE,
            MediaLibrary.MediaType.VIDEO,
          ])
          .limit(pageSize)
          .offset(offset)
          .exeForMetadata();
        const backupPageAsset = async (index: number): Promise<void> => {
          const metadata = page[index];
          if (metadata === undefined) return;
          await backupAsset(metadata);
          return backupPageAsset(index + 1);
        };
        await backupPageAsset(0);
        if (page.length === pageSize)
          return backupAlbumPage(albumId, offset + page.length);
      };
      const backupAlbum = async (index: number): Promise<void> => {
        const albumId = rules.selectedAlbums[index];
        if (albumId === undefined) return;
        await backupAlbumPage(albumId, 0);
        return backupAlbum(index + 1);
      };
      await backupAlbum(0);
      setLastSuccessfulSync(
        Store.get<string | undefined>(LAST_SUCCESSFUL_SYNC_KEY, undefined)
      );
    } finally {
      setRunning(false);
    }
  };
  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.bg }]}
      edges={["top"]}
    >
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()}>
          <Feather name="chevron-left" size={26} color={colors.ink} />
        </Pressable>
        <Text style={[styles.title, { color: colors.ink }]}>Backup health</Text>
        <View style={{ width: 26 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View
          style={[
            styles.hero,
            {
              backgroundColor: pending.length ? colors.bgSunken : colors.bgElev,
              borderColor: colors.line,
            },
          ]}
        >
          <Feather
            name={pending.length ? "cloud" : "check-circle"}
            size={30}
            color={pending.length ? colors.accent : "#2f9d6a"}
          />
          <Text style={[styles.heroValue, { color: colors.ink }]}>
            {pending.length ? `${pending.length} pending` : "Backup is healthy"}
          </Text>
          <Text style={[styles.meta, { color: colors.ink2 }]}>
            {pending.length
              ? `${formatBytes(bytes)} remaining`
              : "The durable queue is empty."}
          </Text>
          <Text style={[styles.meta, { color: colors.ink2 }]}>
            Last successful sync:{" "}
            {lastSuccessfulSync ? formatSyncTime(lastSuccessfulSync) : "Never"}
          </Text>
        </View>
        {inCloudSkipped ? (
          <View style={[styles.warning, { borderColor: colors.danger }]}>
            <Feather name="cloud-off" size={18} color={colors.danger} />
            <Text style={[styles.warningText, { color: colors.danger }]}>
              {inCloudSkipped}{" "}
              {inCloudSkipped === 1 ? "original is" : "originals are"}{" "}
              {IN_CLOUD_MESSAGE}, so{" "}
              {inCloudSkipped === 1 ? "it was" : "they were"} not backed up.
              Download {inCloudSkipped === 1 ? "it" : "them"} in the Photos app
              and run this again.
            </Text>
          </View>
        ) : null}
        <Text style={[styles.section, { color: colors.ink2 }]}>
          TRANSFER RULES
        </Text>
        <Rule
          label="Wi-Fi only"
          value={rules.wifiOnly}
          onValueChange={(value) => update({ ...rules, wifiOnly: value })}
          colors={colors}
        />
        <Rule
          label="Allow metered or cellular"
          value={rules.allowMetered}
          onValueChange={(value) => update({ ...rules, allowMetered: value })}
          colors={colors}
          disabled={rules.wifiOnly}
        />
        <Rule
          label="Only while charging"
          value={rules.chargerOnly}
          onValueChange={(value) => update({ ...rules, chargerOnly: value })}
          colors={colors}
        />
        <Text style={[styles.section, { color: colors.ink2 }]}>
          DEVICE ALBUMS
        </Text>
        {albumError ? (
          <Text style={[styles.error, { color: colors.danger }]}>
            Device albums could not be read: {albumError}
          </Text>
        ) : null}
        {albums.map((album) => {
          const active = rules.selectedAlbums.includes(album.id);
          return (
            <Rule
              key={album.id}
              label={album.title}
              value={active}
              onValueChange={(value) => {
                update({
                  ...rules,
                  selectedAlbums: value
                    ? [...new Set([...rules.selectedAlbums, album.id])]
                    : rules.selectedAlbums.filter((id) => id !== album.id),
                });
              }}
              colors={colors}
            />
          );
        })}
        <Pressable
          disabled={running || rules.selectedAlbums.length === 0}
          style={[
            styles.settings,
            {
              backgroundColor: rules.selectedAlbums.length
                ? colors.accent
                : colors.bgSunken,
              borderColor: colors.line,
            },
          ]}
          onPress={() => void backupAlbums()}
        >
          <Feather
            name="upload-cloud"
            size={18}
            color={rules.selectedAlbums.length ? colors.onAccent : colors.ink3}
          />
          <Text
            style={[
              styles.settingsText,
              {
                color: rules.selectedAlbums.length
                  ? colors.onAccent
                  : colors.ink3,
              },
            ]}
          >
            {running
              ? "Backing up selected albums…"
              : "Back up selected albums now"}
          </Text>
        </Pressable>
        <Text style={[styles.section, { color: colors.ink2 }]}>STORAGE</Text>
        <Text style={[styles.storage, { color: colors.ink }]}>{storage}</Text>
        {pending
          .filter((item) => item.lastError)
          .map((item, index) => (
            <Text key={index} style={[styles.error, { color: colors.danger }]}>
              {item.filename ?? "Asset"}: {item.lastError}
            </Text>
          ))}
        {Platform.OS === "android" ? (
          <Pressable
            style={[styles.settings, { borderColor: colors.line }]}
            onPress={() => void Linking.openSettings()}
          >
            <Feather name="battery-charging" size={18} color={colors.accent} />
            <Text style={[styles.settingsText, { color: colors.ink }]}>
              Review battery optimization
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Rule({
  label,
  value,
  onValueChange,
  colors,
  disabled = false,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  colors: ReturnType<typeof useTheme>["colors"];
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <View style={[styles.rule, { borderBottomColor: colors.line }]}>
      <Text
        style={[
          styles.ruleLabel,
          { color: disabled ? colors.ink3 : colors.ink },
        ]}
      >
        {label}
      </Text>
      <Switch
        disabled={disabled}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: colors.accent }}
      />
    </View>
  );
}

function formatBytes(value: number): string {
  if (value < 1024 ** 2) return `${Math.ceil(value / 1024)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function formatSyncTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? "Unknown"
    : new Date(timestamp).toLocaleString();
}
