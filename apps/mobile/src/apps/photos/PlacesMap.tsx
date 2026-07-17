import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import MapView, { Marker } from 'react-native-maps';

import { useReplicaQuery } from '../../kit/hooks/useReplicaQuery';
import { family, useTheme } from '../../kit/theme';
import type { PhotosScreenProps } from '../../navigation';
import { usePhotoTimeline } from './timeline-source';

export default function PlacesMap({
  navigation,
}: PhotosScreenProps<'PlacesMap'>): React.JSX.Element {
  const { colors } = useTheme();
  const places = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.place' }), []),
  );
  const { assets } = usePhotoTimeline();
  const placeById = new Map(places.rows.map((row) => [String(row.place_id), row]));
  const points = assets.flatMap((asset) => {
    const row = asset.placeId ? placeById.get(asset.placeId) : undefined;
    if (!row) return [];
    const latitude = Number(row.latitude ?? row.lat);
    const longitude = Number(row.longitude ?? row.lon ?? row.lng);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      ? [{ id: asset.id, latitude, longitude, name: String(row.name ?? 'Place') }]
      : [];
  });
  const clusters = [
    ...points
      .reduce((map, point) => {
        const key = `${point.latitude.toFixed(1)}:${point.longitude.toFixed(1)}`;
        const current = map.get(key);
        if (current) {
          current.count += 1;
          current.names.push(point.name);
        } else map.set(key, { ...point, count: 1, names: [point.name] });
        return map;
      }, new Map<string, (typeof points)[number] & { count: number; names: string[] }>())
      .values(),
  ];
  const region = points.length
    ? {
        latitude: points.reduce((sum, point) => sum + point.latitude, 0) / points.length,
        longitude: points.reduce((sum, point) => sum + point.longitude, 0) / points.length,
        latitudeDelta: 30,
        longitudeDelta: 30,
      }
    : { latitude: 20, longitude: 0, latitudeDelta: 100, longitudeDelta: 100 };
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()}>
          <Feather name="chevron-left" size={26} color={colors.ink} />
        </Pressable>
        <Text style={[styles.title, { color: colors.ink }]}>Places</Text>
        <Text style={[styles.count, { color: colors.ink2 }]}>{points.length}</Text>
      </View>
      <MapView initialRegion={region} style={styles.map}>
        {clusters.map((point) => (
          <Marker
            key={point.id}
            coordinate={point}
            title={point.count > 1 ? `${point.count} photos` : point.name}
            description={point.names.slice(0, 3).join(', ')}
          />
        ))}
      </MapView>
      {!points.length ? (
        <View pointerEvents="none" style={styles.empty}>
          <Text style={[styles.emptyText, { backgroundColor: colors.bgElev, color: colors.ink2 }]}>
            Geotagged assets appear here. Set-place changes sync as replica intents.
          </Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  count: { fontFamily: family.monoMedium, fontSize: 11 },
  empty: { alignItems: 'center', bottom: 30, left: 20, position: 'absolute', right: 20 },
  emptyText: {
    borderRadius: 12,
    fontFamily: family.sansRegular,
    fontSize: 13,
    lineHeight: 19,
    padding: 14,
    textAlign: 'center',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 50,
    paddingHorizontal: 14,
  },
  map: { flex: 1 },
  safe: { flex: 1 },
  title: { fontFamily: family.displayBold, fontSize: 18 },
});
