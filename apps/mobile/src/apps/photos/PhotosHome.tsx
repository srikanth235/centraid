import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import { File } from 'expo-file-system';
import * as Notifications from 'expo-notifications';

import { family, useTheme } from '../../kit/theme';
import { useReplica } from '../../kit/replica/ReplicaProvider';
import { useReplicaQuery } from '../../kit/hooks/useReplicaQuery';
import { backupDeviceMedia } from '../../lib/upload/media-producer';
import { Store } from '../../storage';
import type { PhotosScreenProps } from '../../navigation';
import PhotoTimeline from './PhotoTimeline';
import { onThisDay } from './timeline-model';
import { usePhotoTimeline } from './timeline-source';

export default function PhotosHome({
  navigation,
}: PhotosScreenProps<'PhotosHome'>): React.JSX.Element {
  const { colors } = useTheme();
  const { session, gatewayBase } = useReplica();
  const timeline = usePhotoTimeline();
  const [selection, setSelection] = useState(new Set<string>());
  const [backingUp, setBackingUp] = useState(false);
  const collections = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.collection' }), []),
  );
  const memories = useMemo(() => onThisDay(timeline.assets), [timeline.assets]);

  useEffect(() => {
    if (memories.length === 0) return;
    const key = `photos.onThisDay.${new Date().toISOString().slice(0, 10)}`;
    void Store.hydrate(key, false).then(async (scheduled) => {
      if (scheduled) return;
      const permission = await Notifications.getPermissionsAsync();
      if (!permission.granted) return;
      const fireAt = new Date();
      fireAt.setHours(18, 0, 0, 0);
      if (fireAt <= new Date()) fireAt.setTime(Date.now() + 60_000);
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'On this day',
          body: `${memories.length} moments from years past`,
          data: { route: 'Photos' },
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireAt },
      });
      Store.set(key, true);
    });
  }, [memories]);

  const backupSelection = async (): Promise<void> => {
    if (!session || !gatewayBase) {
      Alert.alert('Desktop unavailable', 'Pair or reconnect a gateway before starting backup.');
      return;
    }
    const selected = timeline.assets.filter((asset) => selection.has(asset.id) && asset.localId);
    setBackingUp(true);
    try {
      for (const asset of selected) {
        const info = await MediaLibrary.getAssetInfoAsync(asset.localId!, {
          shouldDownloadFromNetwork: true,
        });
        const uri = info.localUri ?? info.uri;
        const file = new File(uri);
        await backupDeviceMedia(session, gatewayBase, {
          localUri: uri,
          filename: asset.filename,
          mediaType: asset.kind === 'video' ? 'video/mp4' : 'image/jpeg',
          plaintextSize: file.size,
          kind: asset.kind,
          capturedAt: asset.capturedAt,
          tzOffsetMin: -new Date(asset.capturedAt).getTimezoneOffset(),
          captureGroupId: info.pairedVideoAsset ? `live:${asset.localId}` : undefined,
          width: asset.width,
          height: asset.height,
          durationS: asset.durationS,
        });
        // A Live Photo's paired MOV is a distinct durable upload; the canonical
        // HEIC remains the visible asset until the vault grows a compound-media edge.
        if (info.pairedVideoAsset) {
          const pair = await MediaLibrary.getAssetInfoAsync(info.pairedVideoAsset);
          const pairUri = pair.localUri ?? pair.uri;
          await backupDeviceMedia(session, gatewayBase, {
            localUri: pairUri,
            filename: pair.filename,
            mediaType: 'video/quicktime',
            plaintextSize: new File(pairUri).size,
            kind: 'video',
            capturedAt: asset.capturedAt,
            captureGroupId: `live:${asset.localId}`,
            width: pair.width,
            height: pair.height,
            durationS: pair.duration,
          });
        }
      }
      setSelection(new Set());
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert('Backup paused', error instanceof Error ? error.message : String(error));
    } finally {
      setBackingUp(false);
    }
  };

  const addToAlbum = (): void => {
    const albums = collections.rows.slice(0, 6);
    if (!albums.length) {
      navigation.navigate('PhotosLibrary');
      return;
    }
    Alert.alert('Add to album', `${selection.size} selected`, [
      ...albums.map((album) => ({
        text: String(album.name ?? 'Album'),
        onPress: () =>
          void (async () => {
            for (const asset of timeline.assets.filter(
              (item) => selection.has(item.id) && item.assetId,
            )) {
              await session?.write('photos', {
                action: 'add-to-album',
                input: {
                  album_id: String(album.collection_id),
                  asset_id: asset.assetId!,
                },
              });
            }
            setSelection(new Set());
          })(),
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top']}>
      <View style={styles.header}>
        {selection.size ? (
          <>
            <Pressable onPress={() => setSelection(new Set())}>
              <Feather name="x" size={23} color={colors.ink} />
            </Pressable>
            <Text style={[styles.selectionTitle, { color: colors.ink }]}>
              {selection.size} selected
            </Text>
            <Pressable onPress={addToAlbum}>
              <Feather name="folder-plus" size={21} color={colors.accent} />
            </Pressable>
            <Pressable disabled={backingUp} onPress={() => void backupSelection()}>
              <Feather name="upload-cloud" size={22} color={colors.accent} />
            </Pressable>
          </>
        ) : (
          <>
            <Text style={[styles.title, { color: colors.ink }]}>Photos</Text>
            <View style={styles.headerActions}>
              <Pressable
                accessibilityLabel="Search photos"
                onPress={() => navigation.navigate('PhotosSearch')}
              >
                <Feather name="search" size={21} color={colors.ink} />
              </Pressable>
              <Pressable
                accessibilityLabel="Photo library"
                onPress={() => navigation.navigate('PhotosLibrary')}
              >
                <Feather name="more-horizontal" size={22} color={colors.ink} />
              </Pressable>
            </View>
          </>
        )}
      </View>

      {memories.length > 0 && !selection.size ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.memories}
        >
          <Pressable
            style={[styles.memory, { backgroundColor: colors.bgSunken }]}
            onPress={() => navigation.navigate('PhotoLightbox', { assetId: memories[0]!.id })}
          >
            <Text style={[styles.memoryEyebrow, { color: colors.accent }]}>ON THIS DAY</Text>
            <Text style={[styles.memoryTitle, { color: colors.ink }]}>
              {memories.length} moments worth revisiting
            </Text>
            <Text style={[styles.memoryMeta, { color: colors.ink2 }]}>
              {new Date().getFullYear() - new Date(memories[0]!.capturedAt).getFullYear()} years ago
            </Text>
          </Pressable>
        </ScrollView>
      ) : null}

      {timeline.loading ? (
        <View style={styles.center}>
          <Text style={[styles.body, { color: colors.ink2 }]}>Opening your library…</Text>
        </View>
      ) : timeline.sections.length === 0 ? (
        <View style={styles.center}>
          <Feather name="image" size={40} color={colors.accent} />
          <Text style={[styles.emptyTitle, { color: colors.ink }]}>Your library starts here</Text>
          <Text style={[styles.body, { color: colors.ink2 }]}>
            Camera-roll photos appear instantly; long-press any item to back it up.
          </Text>
        </View>
      ) : (
        <PhotoTimeline
          sections={timeline.sections}
          selection={selection}
          onSelectionChange={setSelection}
          onOpen={(asset) => navigation.navigate('PhotoLightbox', { assetId: asset.id })}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: {
    fontFamily: family.sansRegular,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 12,
    maxWidth: 290,
    textAlign: 'center',
  },
  center: { alignItems: 'center', flex: 1, justifyContent: 'center', paddingHorizontal: 28 },
  emptyTitle: { fontFamily: family.displayBold, fontSize: 21, marginTop: 18 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: 18,
  },
  headerActions: { flexDirection: 'row', gap: 22 },
  memories: { padding: 10, paddingHorizontal: 16 },
  memory: { borderRadius: 14, minWidth: 245, padding: 16 },
  memoryEyebrow: { fontFamily: family.monoBold, fontSize: 10, letterSpacing: 1 },
  memoryMeta: { fontFamily: family.sansRegular, fontSize: 12, marginTop: 4 },
  memoryTitle: { fontFamily: family.displayBold, fontSize: 17, marginTop: 7 },
  safe: { flex: 1 },
  selectionTitle: { fontFamily: family.sansBold, fontSize: 15 },
  title: { fontFamily: family.displayBold, fontSize: 23, letterSpacing: -0.6 },
});
