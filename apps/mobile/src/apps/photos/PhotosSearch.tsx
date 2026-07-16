import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { OnlineOnlyError } from '@centraid/client/replica/native';

import { family, useTheme } from '../../kit/theme';
import { useReplica } from '../../kit/replica/ReplicaProvider';
import { useReplicaQuery } from '../../kit/hooks/useReplicaQuery';
import type { PhotosScreenProps } from '../../navigation';
import PhotoTimeline from './PhotoTimeline';
import { sectionPhotoAssets } from './timeline-model';
import { usePhotoTimeline } from './timeline-source';

export default function PhotosSearch({
  navigation,
}: PhotosScreenProps<'PhotosSearch'>): React.JSX.Element {
  const { colors } = useTheme();
  const { session, online } = useReplica();
  const { assets } = usePhotoTimeline();
  const [term, setTerm] = useState('');
  const [contentIds, setContentIds] = useState<Set<string>>();
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [videoOnly, setVideoOnly] = useState(false);
  const [thisYear, setThisYear] = useState(false);
  const [albumId, setAlbumId] = useState<string>();
  const [personId, setPersonId] = useState<string>();
  const [placeId, setPlaceId] = useState<string>();
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const collections = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.collection' }), []),
  );
  const entries = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.collection_entry' }), []),
  );
  const faces = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'media.face_region' }), []),
  );
  const parties = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.party' }), []),
  );
  const places = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.place' }), []),
  );
  const [notice, setNotice] = useState('Search runs against the local FTS5 replica.');
  const [onlineOnly, setOnlineOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      if (!term.trim() || !session) {
        setContentIds(undefined);
        setOnlineOnly(false);
        return;
      }
      void session
        .search('photos', { entity: 'core.content_item', query: term.trim(), limit: 300 })
        .then((result) => {
          if (!cancelled) {
            setContentIds(new Set(result.rows.map((row) => String(row.values.content_id))));
            setOnlineOnly(false);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            if (error instanceof OnlineOnlyError) {
              setContentIds(new Set());
              setOnlineOnly(true);
              setNotice(error.message);
            } else {
              setContentIds(new Set());
              setOnlineOnly(false);
              setNotice(error instanceof Error ? error.message : String(error));
            }
          }
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [online, session, term]);

  const matches = useMemo(() => {
    const albumAssets = new Set(
      entries.rows
        .filter((row) => row.collection_id === albumId)
        .map((row) => String(row.target_id)),
    );
    const personAssets = new Set(
      faces.rows.filter((row) => row.party_id === personId).map((row) => String(row.asset_id)),
    );
    const from = validDate(dateFrom) ? dateFrom : undefined;
    const to = validDate(dateTo) ? dateTo : undefined;
    return assets.filter((asset) => {
      const capturedDay = asset.capturedAt.slice(0, 10);
      return (
        (!contentIds || (asset.contentId && contentIds.has(asset.contentId))) &&
        (!favoriteOnly || asset.favorite) &&
        (!videoOnly || asset.kind === 'video') &&
        (!thisYear || new Date(asset.capturedAt).getFullYear() === new Date().getFullYear()) &&
        (!from || capturedDay >= from) &&
        (!to || capturedDay <= to) &&
        (!albumId || Boolean(asset.assetId && albumAssets.has(asset.assetId))) &&
        (!personId || Boolean(asset.assetId && personAssets.has(asset.assetId))) &&
        (!placeId || asset.placeId === placeId)
      );
    });
  }, [
    albumId,
    assets,
    contentIds,
    dateFrom,
    dateTo,
    entries.rows,
    faces.rows,
    favoriteOnly,
    personId,
    placeId,
    thisYear,
    videoOnly,
  ]);
  const sections = useMemo(() => sectionPhotoAssets(matches), [matches]);
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()}>
          <Feather name="chevron-left" size={26} color={colors.ink} />
        </Pressable>
        <View style={[styles.search, { backgroundColor: colors.bgSunken }]}>
          <Feather name="search" size={17} color={colors.ink2} />
          <TextInput
            autoFocus
            value={term}
            onChangeText={setTerm}
            placeholder="Photos, places, tags…"
            placeholderTextColor={colors.ink3}
            style={[styles.input, { color: colors.ink }]}
          />
        </View>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filters}
      >
        <Pressable
          style={[styles.chip, { backgroundColor: favoriteOnly ? colors.accent : colors.bgSunken }]}
          onPress={() => setFavoriteOnly((value) => !value)}
        >
          <Text style={[styles.chipText, { color: favoriteOnly ? colors.onAccent : colors.ink2 }]}>
            Favorites
          </Text>
        </Pressable>
        <Pressable
          style={[styles.chip, { backgroundColor: videoOnly ? colors.accent : colors.bgSunken }]}
          onPress={() => setVideoOnly((value) => !value)}
        >
          <Text style={[styles.chipText, { color: videoOnly ? colors.onAccent : colors.ink2 }]}>
            Videos
          </Text>
        </Pressable>
        <FilterChip
          label="This year"
          active={thisYear}
          onPress={() => setThisYear((value) => !value)}
          colors={colors}
        />
        {collections.rows.length ? (
          <FilterChip
            label={
              albumId
                ? String(
                    collections.rows.find((row) => String(row.collection_id) === albumId)?.name ??
                      'Album',
                  )
                : 'Album'
            }
            active={Boolean(albumId)}
            onPress={() => setAlbumId(cycleId(collections.rows, 'collection_id', albumId))}
            colors={colors}
          />
        ) : null}
        {parties.rows.length ? (
          <FilterChip
            label={
              personId
                ? String(
                    parties.rows.find((row) => String(row.party_id) === personId)?.display_name ??
                      'Person',
                  )
                : 'Person'
            }
            active={Boolean(personId)}
            onPress={() => setPersonId(cycleId(parties.rows, 'party_id', personId))}
            colors={colors}
          />
        ) : null}
        {places.rows.length ? (
          <FilterChip
            label={
              placeId
                ? String(
                    places.rows.find((row) => String(row.place_id) === placeId)?.name ?? 'Place',
                  )
                : 'Place'
            }
            active={Boolean(placeId)}
            onPress={() => setPlaceId(cycleId(places.rows, 'place_id', placeId))}
            colors={colors}
          />
        ) : null}
      </ScrollView>
      <View style={styles.dateRow}>
        <TextInput
          accessibilityLabel="Photos captured from date"
          value={dateFrom}
          onChangeText={setDateFrom}
          placeholder="From YYYY-MM-DD"
          placeholderTextColor={colors.ink3}
          style={[styles.dateInput, { backgroundColor: colors.bgSunken, color: colors.ink }]}
        />
        <TextInput
          accessibilityLabel="Photos captured through date"
          value={dateTo}
          onChangeText={setDateTo}
          placeholder="To YYYY-MM-DD"
          placeholderTextColor={colors.ink3}
          style={[styles.dateInput, { backgroundColor: colors.bgSunken, color: colors.ink }]}
        />
      </View>
      {onlineOnly ? (
        <View style={[styles.fallback, { backgroundColor: colors.bgSunken }]}>
          <Text style={[styles.fallbackText, { color: colors.ink2 }]}>{notice}</Text>
          <Pressable
            disabled={!online}
            onPress={() =>
              navigation.navigate('Tabs', {
                screen: 'Apps',
                params: { screen: 'AppDetail', params: { appId: 'photos' } },
              })
            }
          >
            <Text style={[styles.fallbackAction, { color: online ? colors.accent : colors.ink3 }]}>
              {online ? 'Search online' : 'Reconnect for online search'}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {!term &&
      !favoriteOnly &&
      !videoOnly &&
      !thisYear &&
      !albumId &&
      !personId &&
      !placeId &&
      !dateFrom &&
      !dateTo ? (
        <Text style={[styles.notice, { color: colors.ink2 }]}>{notice}</Text>
      ) : sections.length ? (
        <PhotoTimeline
          sections={sections}
          selection={new Set()}
          onSelectionChange={() => undefined}
          onOpen={(asset) => navigation.navigate('PhotoLightbox', { assetId: asset.id })}
        />
      ) : (
        <View style={styles.empty}>
          <Text style={[styles.notice, { color: colors.ink2 }]}>
            No matches in the offline index.
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function cycleId(
  rows: Array<Record<string, unknown>>,
  key: string,
  current?: string,
): string | undefined {
  const ids = rows.map((row) => String(row[key] ?? '')).filter(Boolean);
  if (!ids.length) return undefined;
  if (!current) return ids[0];
  const next = ids.indexOf(current) + 1;
  return next >= ids.length ? undefined : ids[next];
}

function FilterChip({
  label,
  active,
  onPress,
  colors,
}: {
  label: string;
  active: boolean;
  onPress(): void;
  colors: ReturnType<typeof useTheme>['colors'];
}): React.JSX.Element {
  return (
    <Pressable
      style={[styles.chip, { backgroundColor: active ? colors.accent : colors.bgSunken }]}
      onPress={onPress}
    >
      <Text style={[styles.chipText, { color: active ? colors.onAccent : colors.ink2 }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  chipText: { fontFamily: family.sansMedium, fontSize: 12 },
  dateInput: {
    borderRadius: 10,
    flex: 1,
    fontFamily: family.sansRegular,
    fontSize: 12,
    padding: 10,
  },
  dateRow: { flexDirection: 'row', gap: 8, paddingBottom: 12, paddingHorizontal: 18 },
  empty: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  filters: { flexDirection: 'row', gap: 8, paddingBottom: 12, paddingHorizontal: 18 },
  fallback: { borderRadius: 12, marginHorizontal: 18, marginBottom: 12, padding: 12 },
  fallbackAction: { fontFamily: family.sansBold, fontSize: 12, marginTop: 5 },
  fallbackText: { fontFamily: family.sansRegular, fontSize: 12, lineHeight: 17 },
  header: { alignItems: 'center', flexDirection: 'row', gap: 10, padding: 12 },
  input: { flex: 1, fontFamily: family.sansRegular, fontSize: 14, paddingVertical: 9 },
  notice: {
    fontFamily: family.sansRegular,
    fontSize: 13,
    lineHeight: 19,
    padding: 24,
    textAlign: 'center',
  },
  safe: { flex: 1 },
  search: {
    alignItems: 'center',
    borderRadius: 12,
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
  },
});
