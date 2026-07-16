import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  Share,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';

import { authHeader } from '../../lib/gateway';
import type { NativeOptimisticMutation } from '../../lib/replica/native-session';
import { useTheme } from '../../kit/theme';
import { useReplica } from '../../kit/replica/ReplicaProvider';
import { useReplicaQuery } from '../../kit/hooks/useReplicaQuery';
import type { PhotosScreenProps } from '../../navigation';
import type { PhotoAsset } from './timeline-model';
import { styles } from './PhotoLightbox.styles';
import { usePhotoTimeline } from './timeline-source';

function VideoAsset({
  uri,
  width,
  height,
}: {
  uri: string;
  width: number;
  height: number;
}): React.JSX.Element {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = false;
  });
  return (
    <VideoView player={player} nativeControls contentFit="contain" style={{ width, height }} />
  );
}

function MediaPage({
  asset,
  companionUri,
  width,
  height,
}: {
  asset: PhotoAsset;
  companionUri?: string;
  width: number;
  height: number;
}): React.JSX.Element {
  const [playingLive, setPlayingLive] = useState(false);
  const [quality, setQuality] = useState<'thumb' | 'preview' | 'original'>('thumb');
  const scale = useSharedValue(1);
  const startScale = useSharedValue(1);
  const zoomStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const pinch = Gesture.Pinch()
    .onStart(() => {
      startScale.value = scale.value;
    })
    .onUpdate(({ scale: nextScale }) => {
      scale.value = Math.max(1, Math.min(5, startScale.value * nextScale));
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(300)
    .onEnd(() => {
      scale.value = withTiming(scale.value > 1 ? 1 : 2.5);
    });
  const zoom = Gesture.Simultaneous(pinch, doubleTap);
  useEffect(() => setQuality('thumb'), [asset.id]);
  if (asset.kind === 'video')
    return <VideoAsset uri={asset.originalUri} width={width} height={height} />;
  if (playingLive && companionUri)
    return <VideoAsset uri={companionUri} width={width} height={height} />;
  return (
    <View style={{ width, height }}>
      <GestureDetector gesture={zoom}>
        <Animated.View style={[styles.mediaCenter, { width, height }, zoomStyle]}>
          <Image
            source={
              quality === 'original'
                ? asset.originalUri
                : quality === 'preview'
                  ? asset.previewUri || asset.uri
                  : asset.uri
            }
            placeholder={asset.thumbhash ? { thumbhash: asset.thumbhash } : undefined}
            contentFit="contain"
            transition={120}
            onLoad={() => {
              if (quality === 'thumb' && asset.previewUri && asset.previewUri !== asset.uri)
                setQuality('preview');
            }}
            style={{ width, height }}
          />
        </Animated.View>
      </GestureDetector>
      {companionUri ? (
        <Pressable style={styles.liveButton} onPress={() => setPlayingLive(true)}>
          <Feather name="play" size={18} color="#fff" />
          <Text style={styles.liveText}>LIVE</Text>
        </Pressable>
      ) : null}
      {quality !== 'original' && asset.originalUri !== asset.previewUri ? (
        <Pressable style={styles.originalButton} onPress={() => setQuality('original')}>
          <Feather name="maximize" size={15} color="#fff" />
          <Text style={styles.liveText}>ORIGINAL</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function PhotoLightbox({
  route,
  navigation,
}: PhotosScreenProps<'PhotoLightbox'>): React.JSX.Element {
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const { session } = useReplica();
  const { assets } = usePhotoTimeline();
  const collections = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.collection' }), []),
  );
  const entries = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.collection_entry' }), []),
  );
  const places = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.place' }), []),
  );
  const initial = Math.max(
    0,
    assets.findIndex((asset) => asset.id === route.params.assetId),
  );
  const [index, setIndex] = useState(initial);
  const [infoOpen, setInfoOpen] = useState(false);
  const [slideshow, setSlideshow] = useState(false);
  const list = useRef<FlatList<PhotoAsset>>(null);
  const current = assets[index];
  const albumIds = new Set(
    entries.rows
      .filter((row) => row.target_id === current?.assetId)
      .map((row) => String(row.collection_id)),
  );
  const albumNames = collections.rows
    .filter((row) => albumIds.has(String(row.collection_id)))
    .map((row) => String(row.name ?? 'Album'));
  const currentPlace = places.rows.find((row) => row.place_id === current?.placeId);
  const dismiss = Gesture.Pan()
    .activeOffsetY([-24, 24])
    .failOffsetX([-24, 24])
    .onEnd(({ translationY, velocityY }) => {
      if (translationY > 120 || velocityY > 900) runOnJS(navigation.goBack)();
    });

  useEffect(() => {
    if (!slideshow || assets.length < 2) return;
    const timer = setInterval(() => {
      setIndex((currentIndex) => {
        const next = (currentIndex + 1) % assets.length;
        list.current?.scrollToIndex({ index: next, animated: true });
        return next;
      });
    }, 3_500);
    return () => clearInterval(timer);
  }, [assets.length, slideshow]);

  const write = async (
    action: string,
    input: Record<string, string | number>,
    optimistic?: NativeOptimisticMutation[],
  ): Promise<void> => {
    if (!session) return;
    const result = await session.write('photos', {
      action,
      input,
      ...(optimistic ? { optimistic } : {}),
    });
    if (result.status === 'parked')
      Alert.alert('Awaiting approval', result.reason ?? 'The change is ready for owner approval.');
  };

  const exportAsset = async (save: boolean): Promise<void> => {
    if (!current) return;
    let uri = current.originalUri;
    if (!uri.startsWith('file:')) {
      const name =
        current.filename ??
        `${current.contentId ?? current.id}.${current.kind === 'video' ? 'mp4' : 'jpg'}`;
      uri = (
        await File.downloadFileAsync(uri, new File(Paths.cache, name), {
          headers: authHeader(),
          idempotent: true,
        })
      ).uri;
    }
    if (save) await MediaLibrary.saveToLibraryAsync(uri);
    else if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
    else await Share.share({ url: uri });
  };

  if (!current) return <View style={[styles.fill, { backgroundColor: '#000' }]} />;
  return (
    <GestureDetector gesture={dismiss}>
      <SafeAreaView style={[styles.fill, { backgroundColor: '#000' }]} edges={['top', 'bottom']}>
        <View style={styles.topbar}>
          <Pressable onPress={() => navigation.goBack()}>
            <Feather name="chevron-down" size={28} color="#fff" />
          </Pressable>
          <Text numberOfLines={1} style={styles.counter}>
            {index + 1} of {assets.length}
          </Text>
          <Pressable onPress={() => setInfoOpen(true)}>
            <Feather name="info" size={22} color="#fff" />
          </Pressable>
        </View>
        <FlatList
          ref={list}
          data={assets}
          horizontal
          pagingEnabled
          initialScrollIndex={initial}
          getItemLayout={(_, itemIndex) => ({
            length: width,
            offset: width * itemIndex,
            index: itemIndex,
          })}
          keyExtractor={(asset) => asset.id}
          onMomentumScrollEnd={(event) =>
            setIndex(Math.round(event.nativeEvent.contentOffset.x / width))
          }
          renderItem={({ item }) => (
            <MediaPage
              asset={item}
              companionUri={item.liveVideoUri}
              width={width}
              height={height - 160}
            />
          )}
          showsHorizontalScrollIndicator={false}
        />
        <View style={styles.toolbar}>
          <Pressable onPress={() => setSlideshow((value) => !value)}>
            <Feather name={slideshow ? 'pause' : 'play'} size={22} color="#fff" />
          </Pressable>
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              void write(
                'update-asset',
                {
                  asset_id: current.assetId!,
                  favorite: current.favorite ? 0 : 1,
                },
                [
                  {
                    op: 'upsert',
                    entity: 'media.media_asset',
                    rowId: current.assetId!,
                    values: { favorite: current.favorite ? 0 : 1 },
                  },
                ],
              );
            }}
            disabled={!current.assetId}
          >
            <Feather name="heart" size={23} color={current.favorite ? '#ff625f' : '#fff'} />
          </Pressable>
          <Pressable onPress={() => void exportAsset(false)}>
            <Feather name="share" size={23} color="#fff" />
          </Pressable>
          <Pressable onPress={() => void exportAsset(true)}>
            <Feather name="download" size={23} color="#fff" />
          </Pressable>
          <Pressable
            disabled={!current.assetId}
            onPress={() =>
              void write(
                'update-asset',
                {
                  asset_id: current.assetId!,
                  archived: current.archived ? 0 : 1,
                },
                [
                  {
                    op: 'upsert',
                    entity: 'media.media_asset',
                    rowId: current.assetId!,
                    values: { archived_at: current.archived ? null : new Date().toISOString() },
                  },
                ],
              )
            }
          >
            <Feather name="archive" size={23} color="#fff" />
          </Pressable>
          <Pressable
            disabled={!current.assetId}
            onPress={() =>
              Alert.alert(
                'Move to trash?',
                'The device original is never deleted by this action.',
                [
                  { text: 'Cancel' },
                  {
                    text: 'Trash',
                    style: 'destructive',
                    onPress: () =>
                      void write('delete-asset', { asset_id: current.assetId! }, [
                        {
                          op: 'upsert',
                          entity: 'media.media_asset',
                          rowId: current.assetId!,
                          values: { deleted_at: new Date().toISOString() },
                        },
                      ]),
                  },
                ],
              )
            }
          >
            <Feather name="trash-2" size={23} color="#fff" />
          </Pressable>
        </View>
        <Modal
          transparent
          animationType="slide"
          visible={infoOpen}
          onRequestClose={() => setInfoOpen(false)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setInfoOpen(false)} />
          <View style={[styles.sheet, { backgroundColor: colors.bgElev }]}>
            <View style={[styles.sheetHandle, { backgroundColor: colors.lineStrong }]} />
            <Text style={[styles.sheetTitle, { color: colors.ink }]}>
              {current.filename ?? 'Photo details'}
            </Text>
            {[
              [
                'Captured',
                new Intl.DateTimeFormat(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(current.capturedAt)),
              ],
              [
                'Timezone',
                current.tzOffsetMin == null
                  ? 'Original offset unavailable'
                  : formatTimezoneOffset(current.tzOffsetMin),
              ],
              [
                'Dimensions',
                current.width && current.height
                  ? `${current.width} × ${current.height}`
                  : 'Unknown',
              ],
              [
                'File size',
                current.fileSize == null
                  ? 'Unknown'
                  : `${(current.fileSize / 1024 / 1024).toFixed(current.fileSize > 10_485_760 ? 0 : 1)} MB`,
              ],
              ['Place', String(currentPlace?.name ?? 'Unknown')],
              ['Albums', albumNames.length ? albumNames.join(', ') : 'None'],
              ['SHA-256', current.sha256 ?? 'Pending backup'],
              ['Backup', current.backupState],
              ['Source', current.source],
            ].map(([label, value]) => (
              <View key={label} style={styles.infoRow}>
                <Text style={[styles.infoLabel, { color: colors.ink2 }]}>{label}</Text>
                <Text
                  selectable
                  numberOfLines={2}
                  style={[styles.infoValue, { color: colors.ink }]}
                >
                  {value}
                </Text>
              </View>
            ))}
            {current.exif ? (
              <Text style={[styles.exif, { color: colors.ink2 }]}>
                {[
                  current.exif.Make,
                  current.exif.Model,
                  current.exif.LensModel,
                  current.exif.ISOSpeedRatings ?? current.exif.ISO,
                  current.exif.ExposureTime,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ) : null}
            {current.assetId && places.rows.length ? (
              <View style={styles.placeActions}>
                {places.rows.slice(0, 3).map((place) => (
                  <Pressable
                    key={place.__rowId}
                    onPress={() =>
                      void write(
                        'set-place',
                        {
                          asset_id: current.assetId!,
                          place_id: String(place.place_id),
                        },
                        [
                          {
                            op: 'upsert',
                            entity: 'media.media_asset',
                            rowId: current.assetId!,
                            values: { place_id: String(place.place_id) },
                          },
                        ],
                      )
                    }
                    style={[styles.placeChip, { backgroundColor: colors.bgSunken }]}
                  >
                    <Text style={[styles.placeText, { color: colors.ink }]}>
                      {String(place.name ?? 'Place')}
                    </Text>
                  </Pressable>
                ))}
                <Pressable
                  onPress={() =>
                    void write('set-place', { asset_id: current.assetId! }, [
                      {
                        op: 'upsert',
                        entity: 'media.media_asset',
                        rowId: current.assetId!,
                        values: { place_id: null },
                      },
                    ])
                  }
                  style={[styles.placeChip, { backgroundColor: colors.bgSunken }]}
                >
                  <Text style={[styles.placeText, { color: colors.ink2 }]}>Clear place</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </Modal>
      </SafeAreaView>
    </GestureDetector>
  );
}

function formatTimezoneOffset(offsetMinutes: number): string {
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `UTC${offsetMinutes >= 0 ? '+' : '-'}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
