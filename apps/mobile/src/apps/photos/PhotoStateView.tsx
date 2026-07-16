import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import { useReplica } from '../../kit/replica/ReplicaProvider';
import { family, useTheme } from '../../kit/theme';
import type { PhotosScreenProps } from '../../navigation';
import PhotoTimeline from './PhotoTimeline';
import { sectionPhotoAssets } from './timeline-model';
import { usePhotoTimeline } from './timeline-source';

export default function PhotoStateView({
  route,
  navigation,
}: PhotosScreenProps<'PhotoStateView'>): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const timeline = usePhotoTimeline();
  const [selection, setSelection] = useState(new Set<string>());
  const mode = route.params.mode;
  const assets = useMemo(
    () =>
      timeline.assets.filter((asset) =>
        mode === 'favorites'
          ? asset.favorite && !asset.deleted
          : mode === 'archive'
            ? asset.archived && !asset.deleted
            : asset.deleted,
      ),
    [mode, timeline.assets],
  );
  const title = mode === 'favorites' ? 'Favorites' : mode === 'archive' ? 'Archive' : 'Trash';
  const apply = async (): Promise<void> => {
    for (const asset of assets.filter((item) => selection.has(item.id) && item.assetId))
      await session?.write(
        'photos',
        mode === 'trash'
          ? { action: 'restore', input: { asset_id: asset.assetId! } }
          : {
              action: 'update-asset',
              input: {
                asset_id: asset.assetId!,
                ...(mode === 'archive' ? { archived: 0 } : { favorite: 0 }),
              },
            },
      );
    setSelection(new Set());
  };
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()}>
          <Feather name="chevron-left" size={26} color={colors.ink} />
        </Pressable>
        <View style={styles.copy}>
          <Text style={[styles.title, { color: colors.ink }]}>{title}</Text>
          <Text style={[styles.meta, { color: colors.ink2 }]}>
            {assets.length} items{mode === 'trash' ? ' · device originals untouched' : ''}
          </Text>
        </View>
        {selection.size ? (
          <Pressable onPress={() => void apply()}>
            <Text style={[styles.action, { color: colors.accent }]}>
              {mode === 'trash' ? 'Restore' : 'Remove'}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {assets.length ? (
        <PhotoTimeline
          sections={sectionPhotoAssets(
            assets.map((asset) => ({ ...asset, archived: false, deleted: false })),
          )}
          selection={selection}
          onSelectionChange={setSelection}
          onOpen={(asset) => navigation.navigate('PhotoLightbox', { assetId: asset.id })}
        />
      ) : (
        <View style={styles.empty}>
          <Text style={[styles.meta, { color: colors.ink2 }]}>Nothing here.</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  action: { fontFamily: family.sansBold, fontSize: 13 },
  copy: { flex: 1, marginLeft: 10 },
  empty: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  header: { alignItems: 'center', flexDirection: 'row', minHeight: 56, paddingHorizontal: 14 },
  meta: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 3 },
  safe: { flex: 1 },
  title: { fontFamily: family.displayBold, fontSize: 18 },
});
