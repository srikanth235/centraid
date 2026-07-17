import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import { useReplicaQuery } from '../../kit/hooks/useReplicaQuery';
import { useReplica } from '../../kit/replica/ReplicaProvider';
import { family, useTheme } from '../../kit/theme';
import type { PhotosScreenProps } from '../../navigation';
import PhotoTimeline from './PhotoTimeline';
import { sectionPhotoAssets } from './timeline-model';
import { usePhotoTimeline } from './timeline-source';
import { Store } from '../../storage';

const KEEP_ORIGINALS_KEY = 'photos.keepOriginalAlbums';

export default function AlbumDetail({
  route,
  navigation,
}: PhotosScreenProps<'AlbumDetail'>): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const timeline = usePhotoTimeline();
  const collections = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.collection' }), []),
  );
  const entries = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.collection_entry' }), []),
  );
  const [selection, setSelection] = useState(new Set<string>());
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState('');
  const [keepOriginals, setKeepOriginals] = useState(false);
  const [pinsReady, setPinsReady] = useState(false);
  const album = collections.rows.find((row) => row.collection_id === route.params.albumId);
  const ids = new Set(
    entries.rows
      .filter((row) => row.collection_id === route.params.albumId)
      .map((row) => String(row.target_id)),
  );
  const assets = timeline.assets.filter((asset) => asset.assetId && ids.has(asset.assetId));
  useEffect(() => {
    setPinsReady(false);
    void Store.hydrate<string[]>(KEEP_ORIGINALS_KEY, []).then((albumIds) => {
      setKeepOriginals(albumIds.includes(route.params.albumId));
      setPinsReady(true);
    });
  }, [route.params.albumId]);
  const toggleKeepOriginals = (next: boolean): void => {
    if (!pinsReady) return;
    const current = Store.get<string[]>(KEEP_ORIGINALS_KEY, []);
    Store.set(
      KEEP_ORIGINALS_KEY,
      next
        ? [...new Set([...current, route.params.albumId])]
        : current.filter((albumId) => albumId !== route.params.albumId),
    );
    setKeepOriginals(next);
  };
  const remove = async (): Promise<void> => {
    for (const asset of assets.filter((item) => selection.has(item.id)))
      await session?.write('photos', {
        action: 'remove-from-album',
        input: { album_id: route.params.albumId, asset_id: asset.assetId! },
      });
    setSelection(new Set());
  };
  const setCover = async (): Promise<void> => {
    const selected = assets.find((item) => selection.has(item.id));
    if (!selected?.assetId || !selected.contentId || !album || !session) return;
    await session.write('photos', {
      action: 'set-album-cover',
      input: { album_id: route.params.albumId, asset_id: selected.assetId },
      optimistic: [
        {
          op: 'upsert',
          entity: 'core.collection',
          rowId: route.params.albumId,
          values: { ...album, cover_content_id: selected.contentId },
        },
      ],
    });
    setSelection(new Set());
  };
  const deleteAlbum = (): void =>
    Alert.alert('Delete album?', 'Photos stay in the library.', [
      { text: 'Keep' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          void session
            ?.write('photos', { action: 'delete-album', input: { album_id: route.params.albumId } })
            .then(() => navigation.goBack()),
      },
    ]);
  const rename = async (): Promise<void> => {
    if (!name.trim()) return;
    await session?.write('photos', {
      action: 'rename-album',
      input: { album_id: route.params.albumId, title: name.trim() },
    });
    setRenameOpen(false);
    setName('');
  };
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()}>
          <Feather name="chevron-left" size={26} color={colors.ink} />
        </Pressable>
        <View style={styles.copy}>
          <Text style={[styles.title, { color: colors.ink }]}>
            {String(album?.name ?? 'Album')}
          </Text>
          <Text style={[styles.meta, { color: colors.ink2 }]}>{assets.length} items</Text>
        </View>
        {selection.size ? (
          <View style={styles.selectionActions}>
            {selection.size === 1 ? (
              <Pressable onPress={() => void setCover()}>
                <Text style={[styles.coverAction, { color: colors.accent }]}>Make cover</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={() => void remove()}>
              <Text style={[styles.remove, { color: colors.danger }]}>Remove</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.actions}>
            <Pressable
              onPress={() => {
                setName(String(album?.name ?? ''));
                setRenameOpen(true);
              }}
            >
              <Feather name="edit-2" size={19} color={colors.accent} />
            </Pressable>
            <Pressable onPress={deleteAlbum}>
              <Feather name="trash-2" size={20} color={colors.danger} />
            </Pressable>
          </View>
        )}
      </View>
      <View style={[styles.keepRow, { borderBottomColor: colors.line }]}>
        <View style={styles.copy}>
          <Text style={[styles.keepTitle, { color: colors.ink }]}>Keep originals on device</Text>
          <Text style={[styles.meta, { color: colors.ink2 }]}>Excluded from Free up space</Text>
        </View>
        <Switch disabled={!pinsReady} value={keepOriginals} onValueChange={toggleKeepOriginals} />
      </View>
      {assets.length ? (
        <PhotoTimeline
          sections={sectionPhotoAssets(assets)}
          selection={selection}
          onSelectionChange={setSelection}
          onOpen={(asset) => navigation.navigate('PhotoLightbox', { assetId: asset.id })}
        />
      ) : (
        <View style={styles.empty}>
          <Text style={[styles.meta, { color: colors.ink2 }]}>This album is empty.</Text>
        </View>
      )}
      <Modal
        transparent
        animationType="fade"
        visible={renameOpen}
        onRequestClose={() => setRenameOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setRenameOpen(false)} />
        <View style={[styles.dialog, { backgroundColor: colors.bgElev }]}>
          <Text style={[styles.dialogTitle, { color: colors.ink }]}>Rename album</Text>
          <TextInput
            autoFocus
            value={name}
            onChangeText={setName}
            style={[styles.input, { borderColor: colors.lineStrong, color: colors.ink }]}
          />
          <Pressable
            onPress={() => void rename()}
            style={[styles.save, { backgroundColor: colors.accent }]}
          >
            <Text style={styles.saveText}>Save</Text>
          </Pressable>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 18 },
  backdrop: { backgroundColor: 'rgba(0,0,0,.4)', flex: 1 },
  copy: { flex: 1, marginLeft: 10 },
  coverAction: { fontFamily: family.sansBold, fontSize: 13 },
  empty: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  dialog: { borderRadius: 16, left: 28, padding: 20, position: 'absolute', right: 28, top: '34%' },
  dialogTitle: { fontFamily: family.displayBold, fontSize: 19 },
  header: { alignItems: 'center', flexDirection: 'row', minHeight: 56, paddingHorizontal: 14 },
  meta: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 3 },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    fontFamily: family.sansRegular,
    fontSize: 15,
    marginTop: 16,
    padding: 12,
  },
  keepRow: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    marginHorizontal: 16,
    paddingVertical: 10,
  },
  keepTitle: { fontFamily: family.sansMedium, fontSize: 13 },
  remove: { fontFamily: family.sansBold, fontSize: 13 },
  selectionActions: { alignItems: 'center', flexDirection: 'row', gap: 14 },
  safe: { flex: 1 },
  save: { alignItems: 'center', borderRadius: 10, marginTop: 12, padding: 12 },
  saveText: { color: '#fff', fontFamily: family.sansBold, fontSize: 13 },
  title: { fontFamily: family.displayBold, fontSize: 18 },
});
