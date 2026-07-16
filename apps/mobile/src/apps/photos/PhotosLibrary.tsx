import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { Image } from 'expo-image';
import { useFocusEffect } from '@react-navigation/native';

import { family, useTheme } from '../../kit/theme';
import { useReplica } from '../../kit/replica/ReplicaProvider';
import { useReplicaQuery } from '../../kit/hooks/useReplicaQuery';
import type { PhotosScreenProps } from '../../navigation';
import { usePhotoTimeline } from './timeline-source';
import { Store } from '../../storage';

const KEEP_ORIGINALS_KEY = 'photos.keepOriginalAlbums';

export default function PhotosLibrary({
  navigation,
}: PhotosScreenProps<'PhotosLibrary'>): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const { assets } = usePhotoTimeline();
  const collections = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.collection' }), []),
  );
  const faces = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'media.face_region' }), []),
  );
  const places = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.place' }), []),
  );
  const policies = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'enrich.policy' }), []),
  );
  const entries = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.collection_entry' }), []),
  );
  const [keptAlbums, setKeptAlbums] = useState<string[]>([]);
  const [pinsReady, setPinsReady] = useState(false);
  const [newAlbum, setNewAlbum] = useState(false);
  const [title, setTitle] = useState('');
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setPinsReady(false);
      void Store.hydrate<string[]>(KEEP_ORIGINALS_KEY, []).then((albumIds) => {
        if (active) {
          setKeptAlbums(albumIds);
          setPinsReady(true);
        }
      });
      return () => {
        active = false;
      };
    }, []),
  );
  const protectedAssets = new Set(
    entries.rows
      .filter((row) => keptAlbums.includes(String(row.collection_id)))
      .map((row) => String(row.target_id)),
  );
  const backedLocal = assets.filter(
    (asset) =>
      asset.localId &&
      asset.assetId &&
      asset.source === 'merged' &&
      asset.backupState === 'backed-up' &&
      asset.verifiedCasAck === true &&
      !protectedAssets.has(asset.assetId),
  );
  const backedBytes = backedLocal.reduce((sum, asset) => sum + (asset.fileSize ?? 0), 0);
  const duplicateCount = assets.filter((asset) => asset.duplicateHint).length;
  const albumRows = [...collections.rows]
    .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
    .map((album) => {
      const assetIds = new Set(
        entries.rows
          .filter((entry) => entry.collection_id === album.collection_id)
          .map((entry) => String(entry.target_id)),
      );
      const albumAssets = assets.filter((asset) => asset.assetId && assetIds.has(asset.assetId));
      const cover =
        albumAssets.find((asset) => asset.contentId === album.cover_content_id) ?? albumAssets[0];
      return { album, cover, count: albumAssets.length };
    });

  const createAlbum = async (): Promise<void> => {
    if (!session || !title.trim()) return;
    await session.write('photos', { action: 'create-album', input: { title: title.trim() } });
    setNewAlbum(false);
    setTitle('');
  };
  const freeSpace = (): void => {
    if (!pinsReady) {
      Alert.alert('Checking device pins', 'Try again after protected albums finish loading.');
      return;
    }
    Alert.alert(
      'Free up space',
      `${backedLocal.length} verified originals (${(backedBytes / 1024 / 1024 / 1024).toFixed(2)} GB) are eligible. Albums pinned to this device are excluded. This is the only action here that touches device originals.`,
      [
        { text: 'Cancel' },
        {
          text: 'Delete from device',
          style: 'destructive',
          onPress: () =>
            void MediaLibrary.deleteAssetsAsync(backedLocal.map((asset) => asset.localId!)),
        },
      ],
    );
  };
  const requestEnrichment = async (): Promise<void> => {
    await session?.write('photos', { action: 'request-enrichment', input: {} });
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()}>
          <Feather name="chevron-left" size={26} color={colors.ink} />
        </Pressable>
        <Text style={[styles.title, { color: colors.ink }]}>Library</Text>
        <Pressable onPress={() => setNewAlbum(true)}>
          <Feather name="plus" size={23} color={colors.accent} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.section, { color: colors.ink2 }]}>YOUR LIBRARY</Text>
        <Pressable onPress={() => navigation.navigate('PhotoStateView', { mode: 'favorites' })}>
          <Row
            icon="heart"
            title="Favorites"
            meta={`${assets.filter((asset) => asset.favorite).length}`}
            colors={colors}
          />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('PhotoStateView', { mode: 'archive' })}>
          <Row
            icon="archive"
            title="Archive"
            meta={`${assets.filter((asset) => asset.archived).length}`}
            colors={colors}
          />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('PhotoStateView', { mode: 'trash' })}>
          <Row
            icon="trash-2"
            title="Trash"
            meta={`${assets.filter((asset) => asset.deleted).length} · vault purge policy`}
            colors={colors}
          />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('FaceReview')}>
          <Row
            icon="users"
            title="People"
            meta={`${new Set(faces.rows.map((row) => row.party_id).filter(Boolean)).size} people · ${faces.rows.filter((row) => !row.confirmed_by_party_id).length} proposals`}
            colors={colors}
          />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('DuplicateReview')}>
          <Row
            icon="copy"
            title="Duplicates review"
            meta={`${duplicateCount} similarity hints`}
            colors={colors}
          />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('PlacesMap')}>
          <Row
            icon="map-pin"
            title="Places"
            meta={`${places.rows.length} saved places`}
            colors={colors}
          />
        </Pressable>
        <Text style={[styles.section, { color: colors.ink2 }]}>ALBUMS</Text>
        {albumRows.length ? (
          <View style={styles.albumGrid}>
            {albumRows.map(({ album, cover, count }) => (
              <Pressable
                key={album.__rowId}
                onPress={() =>
                  navigation.navigate('AlbumDetail', { albumId: String(album.collection_id) })
                }
                style={styles.albumCard}
              >
                {cover ? (
                  <Image source={cover.uri} contentFit="cover" style={styles.albumCover} />
                ) : (
                  <View style={[styles.albumCover, { backgroundColor: colors.bgSunken }]} />
                )}
                <Text numberOfLines={1} style={[styles.albumTitle, { color: colors.ink }]}>
                  {String(album.name ?? 'Album')}
                </Text>
                <Text style={[styles.rowMeta, { color: colors.ink2 }]}>{count} items</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={[styles.empty, { color: colors.ink2 }]}>
            No albums yet. Tap + to create one.
          </Text>
        )}
        <Text style={[styles.section, { color: colors.ink2 }]}>BACKUP & STORAGE</Text>
        <Pressable onPress={() => navigation.navigate('BackupHealth')}>
          <Row
            icon="cloud"
            title="Backup health"
            meta="Rules, queue, errors, storage policy"
            colors={colors}
          />
        </Pressable>
        <Pressable disabled={!pinsReady} onPress={freeSpace}>
          <Row
            icon="hard-drive"
            title="Free up space"
            meta={
              pinsReady
                ? `${backedLocal.length} verified originals · ${(backedBytes / 1024 / 1024 / 1024).toFixed(2)} GB`
                : 'Checking protected albums…'
            }
            colors={colors}
          />
        </Pressable>
        <Pressable onPress={() => void requestEnrichment()}>
          <Row
            icon="zap"
            title="Enrichment"
            meta={`${policies.rows.length} consent policies · request faces, places and metadata`}
            colors={colors}
          />
        </Pressable>
      </ScrollView>
      <Modal
        transparent
        animationType="fade"
        visible={newAlbum}
        onRequestClose={() => setNewAlbum(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setNewAlbum(false)} />
        <View style={[styles.dialog, { backgroundColor: colors.bgElev }]}>
          <Text style={[styles.dialogTitle, { color: colors.ink }]}>New album</Text>
          <TextInput
            autoFocus
            value={title}
            onChangeText={setTitle}
            placeholder="Album name"
            placeholderTextColor={colors.ink3}
            style={[styles.albumInput, { borderColor: colors.lineStrong, color: colors.ink }]}
          />
          <Pressable
            style={[styles.create, { backgroundColor: colors.accent }]}
            onPress={() => void createAlbum()}
          >
            <Text style={styles.createText}>Create</Text>
          </Pressable>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Row({
  icon,
  title,
  meta,
  colors,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  title: string;
  meta: string;
  colors: ReturnType<typeof useTheme>['colors'];
}): React.JSX.Element {
  return (
    <View style={[styles.row, { borderBottomColor: colors.line }]}>
      <View style={[styles.icon, { backgroundColor: colors.bgSunken }]}>
        <Feather name={icon} size={18} color={colors.accent} />
      </View>
      <View style={styles.rowCopy}>
        <Text style={[styles.rowTitle, { color: colors.ink }]}>{title}</Text>
        <Text style={[styles.rowMeta, { color: colors.ink2 }]}>{meta}</Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.ink3} />
    </View>
  );
}

const styles = StyleSheet.create({
  albumCard: { width: '48%' },
  albumCover: { aspectRatio: 1.35, borderRadius: 10, width: '100%' },
  albumGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 10 },
  albumTitle: { fontFamily: family.sansMedium, fontSize: 13, marginTop: 7 },
  albumInput: {
    borderRadius: 10,
    borderWidth: 1,
    fontFamily: family.sansRegular,
    fontSize: 15,
    marginTop: 18,
    padding: 12,
  },
  backdrop: { backgroundColor: 'rgba(0,0,0,.4)', flex: 1 },
  content: { padding: 18, paddingBottom: 60 },
  create: { alignItems: 'center', borderRadius: 10, marginTop: 12, padding: 12 },
  createText: { color: '#fff', fontFamily: family.sansBold, fontSize: 14 },
  dialog: { borderRadius: 16, left: 28, padding: 20, position: 'absolute', right: 28, top: '34%' },
  dialogTitle: { fontFamily: family.displayBold, fontSize: 19 },
  empty: { fontFamily: family.sansRegular, fontSize: 13, paddingVertical: 15 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 50,
    paddingHorizontal: 14,
  },
  icon: { alignItems: 'center', borderRadius: 10, height: 38, justifyContent: 'center', width: 38 },
  row: { alignItems: 'center', borderBottomWidth: 1, flexDirection: 'row', minHeight: 64 },
  rowCopy: { flex: 1, marginLeft: 12 },
  rowMeta: { fontFamily: family.sansRegular, fontSize: 12, marginTop: 3 },
  rowTitle: { fontFamily: family.sansMedium, fontSize: 14 },
  safe: { flex: 1 },
  section: {
    fontFamily: family.monoBold,
    fontSize: 10,
    letterSpacing: 1,
    marginBottom: 4,
    marginTop: 24,
  },
  title: { fontFamily: family.displayBold, fontSize: 18 },
});
