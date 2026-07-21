import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
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
import PhotosCollectionsView from './PhotosCollectionsView';
import PhotosCreateView from './PhotosCreateView';
import PhotosAskView from './PhotosAskView';
import PhotosDrawer from './PhotosDrawer';
import { imageSource } from './media-source';
import { onThisDay } from './timeline-model';
import { usePhotoTimeline } from './timeline-source';

// The bottom-nav active tint is the ochre accent from the design (#B47B3F),
// distinct from the theme's blue `accent` used elsewhere on this screen.
const NAV_ACTIVE = '#B47B3F';

type PhotosView = 'photos' | 'collections' | 'create' | 'ask';

const NAV_ITEMS: Array<{ view: PhotosView; icon: keyof typeof Feather.glyphMap; label: string }> = [
  { view: 'photos', icon: 'grid', label: 'Photos' },
  { view: 'collections', icon: 'layers', label: 'Collections' },
  { view: 'create', icon: 'plus-square', label: 'Create' },
];

export default function PhotosHome({
  navigation,
}: PhotosScreenProps<'PhotosHome'>): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { session, gatewayBase } = useReplica();
  const timeline = usePhotoTimeline();
  const [view, setView] = useState<PhotosView>('photos');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selection, setSelection] = useState(new Set<string>());
  const [backingUp, setBackingUp] = useState(false);
  const collections = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.collection' }), []),
  );
  const memories = useMemo(() => onThisDay(timeline.assets), [timeline.assets]);
  const hero = memories[0];

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

  const yearsAgo = hero ? new Date().getFullYear() - new Date(hero.capturedAt).getFullYear() : 0;
  const selecting = selection.size > 0;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top']}>
      {selecting ? (
        <View style={styles.header}>
          <Pressable onPress={() => setSelection(new Set())}>
            <Feather name="x" size={23} color={colors.ink} />
          </Pressable>
          <Text style={[styles.selectionTitle, { color: colors.ink }]}>
            {selection.size} selected
          </Text>
          <View style={styles.headerActions}>
            <Pressable onPress={addToAlbum}>
              <Feather name="folder-plus" size={21} color={colors.accent} />
            </Pressable>
            <Pressable disabled={backingUp} onPress={() => void backupSelection()}>
              <Feather name="upload-cloud" size={22} color={colors.accent} />
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.searchRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Menu"
            onPress={() => setDrawerOpen(true)}
            style={styles.menuBtn}
          >
            <Feather name="menu" size={23} color={colors.ink2} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Search photos and moments"
            onPress={() => navigation.navigate('PhotosSearch')}
            style={[styles.searchPill, { backgroundColor: colors.bgSunken }]}
          >
            <Feather name="search" size={17} color={colors.ink3} />
            <Text style={[styles.searchPlaceholder, { color: colors.ink3 }]}>
              Search photos &amp; moments
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Ask about your photos"
            onPress={() => setView('ask')}
            style={styles.sparkleBtn}
          >
            <Feather name="star" size={22} color={colors.accent} />
          </Pressable>
        </View>
      )}

      <View style={styles.body}>
        {view === 'photos' ? (
          <>
            {hero && !selecting ? (
              <Pressable
                style={styles.heroWrap}
                onPress={() => navigation.navigate('PhotoLightbox', { assetId: hero.id })}
              >
                <Image source={imageSource(hero.uri)} contentFit="cover" style={styles.heroImage} />
                <View style={styles.heroShade} />
                <View style={[styles.memoryPill, { backgroundColor: 'rgba(0,0,0,.32)' }]}>
                  <Feather name="star" size={12} color="#fff" />
                  <Text style={styles.memoryPillText}>Memory</Text>
                </View>
                <View style={styles.heroCopy}>
                  <Text style={styles.heroEyebrow}>ON THIS DAY</Text>
                  <Text style={styles.heroTitle}>
                    {yearsAgo > 0 ? `${yearsAgo} year${yearsAgo === 1 ? '' : 's'} ago` : 'Today'}
                    {memories.length > 1 ? ` · ${memories.length} moments` : ''}
                  </Text>
                </View>
              </Pressable>
            ) : null}

            {!selecting && timeline.assets.length ? (
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
                <Text style={[styles.body2, { color: colors.ink2 }]}>Opening your library…</Text>
              </View>
            ) : timeline.sections.length === 0 ? (
              <View style={styles.center}>
                <Feather name="image" size={40} color={colors.accent} />
                <Text style={[styles.emptyTitle, { color: colors.ink }]}>
                  Your library starts here
                </Text>
                <Text style={[styles.body2, { color: colors.ink2 }]}>
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
          </>
        ) : view === 'collections' ? (
          <PhotosCollectionsView navigation={navigation} />
        ) : view === 'create' ? (
          <PhotosCreateView />
        ) : (
          <PhotosAskView navigation={navigation} />
        )}
      </View>

      {selecting ? null : (
        <View
          style={[
            styles.bottomNav,
            {
              backgroundColor: colors.bg,
              borderTopColor: colors.line,
              paddingBottom: Math.max(insets.bottom, 14),
            },
          ]}
        >
          {NAV_ITEMS.map((item) => {
            const active = view === item.view;
            return (
              <Pressable
                key={item.view}
                style={styles.navItem}
                onPress={() => setView(item.view)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={item.label}
              >
                <Feather name={item.icon} size={23} color={active ? NAV_ACTIVE : colors.ink3} />
                <Text style={[styles.navLabel, { color: active ? NAV_ACTIVE : colors.ink3 }]}>
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
          <Pressable
            style={styles.navItem}
            onPress={() => navigation.navigate('Apps', { screen: 'Home' })}
            accessibilityRole="button"
            accessibilityLabel="Home"
          >
            <Feather name="home" size={23} color={colors.ink3} />
            <Text style={[styles.navLabel, { color: colors.ink3 }]}>Home</Text>
          </Pressable>
        </View>
      )}

      <PhotosDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onHome={() => {
          setDrawerOpen(false);
          navigation.navigate('Apps', { screen: 'Home' });
        }}
        onSettings={() => {
          setDrawerOpen(false);
          navigation.navigate('SettingsTab', { screen: 'Settings' });
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  body2: {
    fontFamily: family.sansRegular,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 12,
    maxWidth: 290,
    textAlign: 'center',
  },
  bottomNav: {
    borderTopWidth: 0.5,
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingTop: 10,
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
  heroCopy: { bottom: 15, left: 16, position: 'absolute', right: 16 },
  heroEyebrow: {
    color: '#fff',
    fontFamily: family.monoMedium,
    fontSize: 11,
    letterSpacing: 1,
    opacity: 0.9,
  },
  heroImage: { ...StyleSheet.absoluteFillObject },
  heroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10,14,24,.28)',
  },
  heroTitle: {
    color: '#fff',
    fontFamily: family.displayBold,
    fontSize: 21,
    letterSpacing: -0.4,
    marginTop: 6,
  },
  heroWrap: {
    borderRadius: 16,
    height: 176,
    marginBottom: 4,
    marginHorizontal: 16,
    marginTop: 8,
    overflow: 'hidden',
  },
  memoryPill: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    position: 'absolute',
    right: 12,
    top: 11,
  },
  memoryPillText: { color: '#fff', fontFamily: family.sansMedium, fontSize: 12 },
  menuBtn: { alignItems: 'flex-start', height: 44, justifyContent: 'center', width: 24 },
  navItem: { alignItems: 'center', flex: 1, gap: 4 },
  navLabel: { fontFamily: family.sansMedium, fontSize: 10 },
  protectedStatus: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  protectedText: { fontFamily: family.sansMedium, fontSize: 11 },
  safe: { flex: 1 },
  searchPill: {
    alignItems: 'center',
    borderRadius: 22,
    flex: 1,
    flexDirection: 'row',
    gap: 9,
    height: 44,
    paddingHorizontal: 16,
  },
  searchPlaceholder: { fontFamily: family.sansRegular, fontSize: 15 },
  searchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingBottom: 10,
    paddingHorizontal: 16,
    paddingTop: 6,
  },
  selectionTitle: { fontFamily: family.sansBold, fontSize: 15 },
  sparkleBtn: { alignItems: 'center', height: 44, justifyContent: 'center', width: 32 },
  timelineHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 7,
    paddingHorizontal: 18,
    paddingTop: 10,
  },
  timelineMeta: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 2 },
  timelineTitle: { fontFamily: family.displayBold, fontSize: 17 },
});
