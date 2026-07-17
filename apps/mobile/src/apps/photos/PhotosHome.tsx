import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
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
import { imageSource } from './media-source';
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
          // The capture's true UTC offset isn't in MediaLibrary metadata, so we
          // record none rather than fabricating the device's current offset —
          // sectioning falls back to the viewing device's local day (matching
          // BackupHealth, which also passes no offset).
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

      {!selection.size ? (
        <View style={[styles.sectionNav, { backgroundColor: colors.bgSunken }]}>
          <View style={[styles.sectionNavItem, { backgroundColor: colors.bgElev }]}>
            <Feather name="clock" size={15} color={colors.accent} />
            <Text style={[styles.sectionNavText, { color: colors.ink }]}>Timeline</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open photo library"
            onPress={() => navigation.navigate('PhotosLibrary')}
            style={styles.sectionNavItem}
          >
            <Feather name="grid" size={15} color={colors.ink2} />
            <Text style={[styles.sectionNavText, { color: colors.ink2 }]}>Library</Text>
          </Pressable>
        </View>
      ) : null}

      {memories.length > 0 && !selection.size ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.memories}
        >
          {memories.slice(0, 3).map((memory, index) => (
            <Pressable
              key={memory.id}
              style={styles.memory}
              onPress={() => navigation.navigate('PhotoLightbox', { assetId: memory.id })}
            >
              <Image
                source={imageSource(memory.uri)}
                contentFit="cover"
                style={styles.memoryImage}
              />
              <View style={styles.memoryShade} />
              <View style={styles.memoryCopy}>
                <Text style={styles.memoryEyebrow}>{index === 0 ? 'ON THIS DAY' : 'MEMORY'}</Text>
                <Text style={styles.memoryTitle}>
                  {index === 0 ? `${memories.length} moments` : memory.filename || 'A moment'}
                </Text>
                <Text style={styles.memoryMeta}>
                  {new Date().getFullYear() - new Date(memory.capturedAt).getFullYear()} years ago
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {!selection.size && timeline.assets.length ? (
        <View style={styles.timelineHeading}>
          <View>
            <Text style={[styles.timelineTitle, { color: colors.ink }]}>Timeline</Text>
            <Text style={[styles.timelineMeta, { color: colors.ink2 }]}>
              {timeline.assets.length} items · pinch to change density
            </Text>
          </View>
          <View style={styles.protectedStatus}>
            <Feather name="shield" size={13} color={colors.accent} />
            <Text style={[styles.protectedText, { color: colors.accent }]}>Private</Text>
          </View>
        </View>
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
  memories: { gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
  memory: { borderRadius: 15, height: 132, overflow: 'hidden', width: 218 },
  memoryCopy: { bottom: 13, left: 14, position: 'absolute', right: 12 },
  memoryEyebrow: { color: '#fff', fontFamily: family.monoBold, fontSize: 9, letterSpacing: 1 },
  memoryImage: { ...StyleSheet.absoluteFillObject },
  memoryMeta: {
    color: 'rgba(255,255,255,.82)',
    fontFamily: family.sansRegular,
    fontSize: 11,
    marginTop: 3,
  },
  memoryShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,14,24,.33)' },
  memoryTitle: { color: '#fff', fontFamily: family.displayBold, fontSize: 18, marginTop: 5 },
  protectedStatus: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  protectedText: { fontFamily: family.sansMedium, fontSize: 11 },
  safe: { flex: 1 },
  sectionNav: { borderRadius: 11, flexDirection: 'row', marginHorizontal: 16, padding: 3 },
  sectionNavItem: {
    alignItems: 'center',
    borderRadius: 8,
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 34,
  },
  sectionNavText: { fontFamily: family.sansMedium, fontSize: 12 },
  selectionTitle: { fontFamily: family.sansBold, fontSize: 15 },
  timelineHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 7,
    paddingHorizontal: 18,
    paddingTop: 6,
  },
  timelineMeta: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 2 },
  timelineTitle: { fontFamily: family.displayBold, fontSize: 17 },
  title: { fontFamily: family.displayBold, fontSize: 23, letterSpacing: -0.6 },
});
