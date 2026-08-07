// Places on the phone (Photos v4 handoff §14, §18).
//
// A shelf reached from the More sheet, not a destination of its own. The map is
// the content; everything this screen adds is a header that names the shelf and
// states its size exactly — a count is a numeral, so it reads in mono.
//
// The empty state is the shelf's own: a place is not something a member forgot
// to do, it is something a photograph either carries or does not.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import MapView, { Marker } from "react-native-maps";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import { usePhotoTimeline } from "./timeline-source";

export default function PlacesMap({
  navigation,
}: PhotosScreenProps<"PlacesMap">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const places = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.place" }), [])
  );
  const { assets } = usePhotoTimeline();
  const placeById = new Map(
    places.rows.map((row) => [String(row.place_id), row])
  );
  const points = assets.flatMap((asset) => {
    const row = asset.placeId ? placeById.get(asset.placeId) : undefined;
    if (!row) return [];
    const latitude = Number(row.latitude ?? row.lat);
    const longitude = Number(row.longitude ?? row.lon ?? row.lng);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      ? [
          {
            id: asset.id,
            latitude,
            longitude,
            name: String(row.name ?? "Place"),
          },
        ]
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
        latitude:
          points.reduce((sum, point) => sum + point.latitude, 0) /
          points.length,
        longitude:
          points.reduce((sum, point) => sum + point.longitude, 0) /
          points.length,
        latitudeDelta: 30,
        longitudeDelta: 30,
      }
    : { latitude: 20, longitude: 0, latitudeDelta: 100, longitudeDelta: 100 };
  return (
    <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to Photos"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
          style={styles.headerBtn}
        >
          <Icon name="chevron-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>Places</Text>
        {/* Stated exactly, in mono: how many geotagged photographs are drawn,
            and out of how many the library holds. Never a badge. */}
        <Text style={styles.count}>
          {points.length} of {assets.length}
        </Text>
      </View>
      <ReplicaStatusBar />
      <MapView initialRegion={region} style={styles.map}>
        {clusters.map((point) => (
          <Marker
            key={point.id}
            coordinate={point}
            title={point.count > 1 ? `${point.count} photographs` : point.name}
            description={point.names.slice(0, 3).join(", ")}
          />
        ))}
      </MapView>
      {points.length ? null : (
        <View pointerEvents="none" style={styles.empty}>
          <Text style={styles.emptyText}>
            No places yet — a photograph lands here once it carries where it was
            taken.
          </Text>
        </View>
      )}
    </TopSafeArea>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    count: { ...t("mono"), color: colors.textSoft },
    empty: {
      alignItems: "center",
      bottom: spacing[5],
      insetInlineEnd: spacing[5],
      insetInlineStart: spacing[5],
      position: "absolute",
    },
    emptyText: {
      ...t("small"),
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: 12,
      borderWidth: borders.hairline,
      color: colors.textSoft,
      overflow: "hidden",
      padding: spacing[4],
      textAlign: "center",
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      minHeight: 48,
      paddingEnd: spacing[4],
      paddingStart: spacing[2],
    },
    headerBtn: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    map: { flex: 1 },
    safe: { flex: 1 },
    title: { ...t("title"), color: colors.text, flex: 1 },
  });
