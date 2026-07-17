import React, { useEffect, useMemo, useState } from 'react';
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { File } from 'expo-file-system';

import { authHeader } from '../../lib/gateway';
import { UploadQueue } from '../../lib/upload/native-queue';
import { backupDeviceMedia } from '../../lib/upload/media-producer';
import { LAST_SUCCESSFUL_SYNC_KEY, nativeUploadPolicy } from '../../lib/upload/native-policy';
import { family, useTheme } from '../../kit/theme';
import { useReplica } from '../../kit/replica/ReplicaProvider';
import { Store } from '../../storage';
import type { PhotosScreenProps } from '../../navigation';

interface Rules {
  wifiOnly: boolean;
  allowMetered: boolean;
  chargerOnly: boolean;
  selectedAlbums: string[];
}
const RULES_KEY = 'photos.backupRules';
const DEFAULT_RULES: Rules = {
  wifiOnly: true,
  allowMetered: false,
  chargerOnly: false,
  selectedAlbums: [],
};

export default function BackupHealth({
  navigation,
}: PhotosScreenProps<'BackupHealth'>): React.JSX.Element {
  const { colors } = useTheme();
  const { gatewayBase, online, session } = useReplica();
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  const [albums, setAlbums] = useState<MediaLibrary.Album[]>([]);
  const [pending, setPending] = useState<
    Array<{ plaintextSize: number; lastError?: string; filename?: string }>
  >([]);
  const [storage, setStorage] = useState('Storage policy unavailable offline');
  const [running, setRunning] = useState(false);
  const [lastSuccessfulSync, setLastSuccessfulSync] = useState<string>();

  useEffect(() => {
    void Store.hydrate(RULES_KEY, DEFAULT_RULES).then((value) =>
      setRules({ ...DEFAULT_RULES, ...value }),
    );
    void Store.hydrate<string | undefined>(LAST_SUCCESSFUL_SYNC_KEY, undefined).then(
      setLastSuccessfulSync,
    );
    void MediaLibrary.getAlbumsAsync()
      .then(setAlbums)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!gatewayBase) return;
    const queue = UploadQueue.open({ gatewayBaseUrl: gatewayBase, headers: authHeader });
    setPending(queue.pending());
    queue.close();
    if (online)
      void fetch(`${gatewayBase}/centraid/_gateway/storage/status`, { headers: authHeader() })
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
                `${vault.replicated?.count ?? 0} replicated · ${vault.backlog?.count ?? 0} offsite · policy ${vault.casAck ?? 'unknown'}`,
              );
          },
        )
        .catch(() => undefined);
  }, [gatewayBase, online]);

  const bytes = useMemo(
    () => pending.reduce((sum, item) => sum + item.plaintextSize, 0),
    [pending],
  );
  const update = (next: Rules): void => {
    setRules(next);
    Store.set(RULES_KEY, next);
  };
  const backupAlbums = async (): Promise<void> => {
    if (!session || !gatewayBase || rules.selectedAlbums.length === 0) return;
    if (!(await nativeUploadPolicy().canTransfer())) return;
    setRunning(true);
    try {
      for (const albumId of rules.selectedAlbums) {
        let after: string | undefined;
        do {
          const page = await MediaLibrary.getAssetsAsync({
            album: albumId,
            first: 250,
            ...(after ? { after } : {}),
            mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
          });
          for (const asset of page.assets) {
            const info = await MediaLibrary.getAssetInfoAsync(asset, {
              shouldDownloadFromNetwork: true,
            });
            const uri = info.localUri ?? info.uri;
            await backupDeviceMedia(session, gatewayBase, {
              localUri: uri,
              filename: info.filename,
              mediaType:
                info.mediaType === MediaLibrary.MediaType.video ? 'video/mp4' : 'image/jpeg',
              plaintextSize: new File(uri).size,
              kind: info.mediaType === MediaLibrary.MediaType.video ? 'video' : 'photo',
              capturedAt: new Date(info.creationTime).toISOString(),
              captureGroupId: info.pairedVideoAsset ? `live:${info.id}` : undefined,
              width: info.width,
              height: info.height,
              durationS: info.duration,
            });
            if (info.pairedVideoAsset) {
              const pair = await MediaLibrary.getAssetInfoAsync(info.pairedVideoAsset);
              const pairUri = pair.localUri ?? pair.uri;
              await backupDeviceMedia(session, gatewayBase, {
                localUri: pairUri,
                filename: pair.filename,
                mediaType: 'video/quicktime',
                plaintextSize: new File(pairUri).size,
                kind: 'video',
                capturedAt: new Date(info.creationTime).toISOString(),
                captureGroupId: `live:${info.id}`,
                width: pair.width,
                height: pair.height,
                durationS: pair.duration,
              });
            }
          }
          after = page.hasNextPage ? page.endCursor : undefined;
        } while (after);
      }
      setLastSuccessfulSync(Store.get<string | undefined>(LAST_SUCCESSFUL_SYNC_KEY, undefined));
    } finally {
      setRunning(false);
    }
  };
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top']}>
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
            name={pending.length ? 'cloud' : 'check-circle'}
            size={30}
            color={pending.length ? colors.accent : '#2f9d6a'}
          />
          <Text style={[styles.heroValue, { color: colors.ink }]}>
            {pending.length ? `${pending.length} pending` : 'Backup is healthy'}
          </Text>
          <Text style={[styles.meta, { color: colors.ink2 }]}>
            {pending.length ? `${formatBytes(bytes)} remaining` : 'The durable queue is empty.'}
          </Text>
          <Text style={[styles.meta, { color: colors.ink2 }]}>
            Last successful sync:{' '}
            {lastSuccessfulSync ? formatSyncTime(lastSuccessfulSync) : 'Never'}
          </Text>
        </View>
        <Text style={[styles.section, { color: colors.ink2 }]}>TRANSFER RULES</Text>
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
        <Text style={[styles.section, { color: colors.ink2 }]}>DEVICE ALBUMS</Text>
        {albums.map((album) => {
          const active = rules.selectedAlbums.includes(album.id);
          return (
            <Rule
              key={album.id}
              label={`${album.title} · ${album.assetCount ?? 0}`}
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
              backgroundColor: rules.selectedAlbums.length ? colors.accent : colors.bgSunken,
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
              { color: rules.selectedAlbums.length ? colors.onAccent : colors.ink3 },
            ]}
          >
            {running ? 'Backing up selected albums…' : 'Back up selected albums now'}
          </Text>
        </Pressable>
        <Text style={[styles.section, { color: colors.ink2 }]}>STORAGE</Text>
        <Text style={[styles.storage, { color: colors.ink }]}>{storage}</Text>
        {pending
          .filter((item) => item.lastError)
          .map((item, index) => (
            <Text key={index} style={[styles.error, { color: colors.danger }]}>
              {item.filename ?? 'Asset'}: {item.lastError}
            </Text>
          ))}
        {Platform.OS === 'android' ? (
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
  onValueChange(value: boolean): void;
  colors: ReturnType<typeof useTheme>['colors'];
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <View style={[styles.rule, { borderBottomColor: colors.line }]}>
      <Text style={[styles.ruleLabel, { color: disabled ? colors.ink3 : colors.ink }]}>
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
  return Number.isNaN(timestamp) ? 'Unknown' : new Date(timestamp).toLocaleString();
}

const styles = StyleSheet.create({
  content: { padding: 18, paddingBottom: 50 },
  error: { fontFamily: family.sansRegular, fontSize: 12, marginVertical: 5 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 50,
    paddingHorizontal: 14,
  },
  hero: { alignItems: 'center', borderRadius: 16, borderWidth: 1, padding: 26 },
  heroValue: { fontFamily: family.displayBold, fontSize: 20, marginTop: 12 },
  meta: { fontFamily: family.sansRegular, fontSize: 13, marginTop: 5 },
  rule: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 52,
  },
  ruleLabel: { fontFamily: family.sansRegular, fontSize: 14 },
  safe: { flex: 1 },
  section: {
    fontFamily: family.monoBold,
    fontSize: 10,
    letterSpacing: 1,
    marginBottom: 6,
    marginTop: 26,
  },
  settings: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginTop: 24,
    padding: 15,
  },
  settingsText: { fontFamily: family.sansMedium, fontSize: 14 },
  storage: { fontFamily: family.sansRegular, fontSize: 14, lineHeight: 20 },
  title: { fontFamily: family.displayBold, fontSize: 18 },
});
