// Places, cards first (Photos v4 handoff §14, §18, proto:4197, :3939-3940,
// :4050-4063 via :4428).
//
// The shelf the More sheet's "Places" row opens. It used to open the map
// directly (`PlacesMap.tsx`) — the handoff is explicit that on the phone this
// is inverted: place cards are the content, the map is a bounded control in
// the head that opens a second, full screen. North star is Google Photos:
// Places reads as an album-like grid, not a map with a list bolted on.
//
// The header count is the number of PLACES ("Places · 42", proto:3939), not
// "N of M geotagged photographs" — that sentence belonged to the old map-first
// screen and answered the wrong question here.
//
// Tapping a card opens that place's photographs. `PhotoStateView` (People's
// destination for the same shape of tap) is owned by another agent mid-flight
// and has no "place" mode; rather than grow a file that is not this issue's to
// edit, the filter lives locally in `PlaceDetail.tsx`, colocated with this
// screen.

import { Image } from "expo-image";
import React, { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PLACE_UNNAMED } from "@centraid/blueprints/apps/photos/shared-copy";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { imageSource } from "../../kit/media/media-source";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import { usePhotoTimeline } from "./timeline-source";

interface PlaceCard {
  id: string;
  name: string;
  count: number;
  coverUri?: string;
}

// Places group by rounding each capture's coordinates to one decimal (roughly
// 11km) — the same 0.1°-proximity `PlacesMap` clusters by, so a place card
// here and a map pin there name the same group.

export default function PlacesView({
  navigation,
}: PhotosScreenProps<"PlacesView">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const places = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.place" }), [])
  );
  const { assets } = usePhotoTimeline();
  const placeById = useMemo(
    () => new Map(places.rows.map((row) => [String(row.place_id), row])),
    [places.rows]
  );

  const cards = useMemo<PlaceCard[]>(() => {
    const groups = new Map<
      string,
      { name: string; count: number; coverUri?: string }
    >();
    for (const asset of assets) {
      if (!asset.placeId) continue;
      const row = placeById.get(asset.placeId);
      if (!row) continue;
      const latitude = Number(row.latitude ?? row.lat);
      const longitude = Number(row.longitude ?? row.lon ?? row.lng);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      const key = `${latitude.toFixed(1)}:${longitude.toFixed(1)}`;
      const name = row.name ? String(row.name) : PLACE_UNNAMED;
      const current = groups.get(key);
      if (current) {
        current.count += 1;
        current.coverUri ??= asset.previewUri ?? asset.uri;
      } else {
        groups.set(key, {
          name,
          count: 1,
          coverUri: asset.previewUri ?? asset.uri,
        });
      }
    }
    return [...groups.entries()]
      .map(([id, group]) => ({ id, ...group }))
      .sort((a, b) => b.count - a.count);
  }, [assets, placeById]);

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.bg }]}
      edges={["top"]}
    >
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
        {/* Places · N — the shelf's own size, in mono because a count is a
            numeral (proto:3939). Never "N of M geotagged" here; that
            sentence belongs to the map, not the shelf. */}
        <Text style={styles.count}>Places · {cards.length}</Text>
        <Pressable
          accessibilityLabel="Open map"
          accessibilityRole="button"
          onPress={() => navigation.navigate("PlacesMap")}
          style={[styles.mapChip, { borderColor: colors.line }]}
        >
          <Text style={[styles.mapChipText, { color: colors.textSoft }]}>
            Map
          </Text>
        </Pressable>
      </View>
      <ReplicaStatusBar />
      <FlatList
        data={cards}
        keyExtractor={(item) => item.id}
        numColumns={2}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.row}
        ListEmptyComponent={
          <Text style={styles.empty}>
            No places yet — a place is not something a member forgot to do, it
            is something a photograph either carries or does not.
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${item.count} photographs`}
            style={styles.card}
            onPress={() =>
              navigation.navigate("PlaceDetail", {
                placeKey: item.id,
                placeName: item.name,
              })
            }
          >
            <View style={[styles.cover, { backgroundColor: colors.skel }]}>
              {item.coverUri ? (
                <Image
                  source={imageSource(item.coverUri)}
                  style={styles.coverImage}
                  contentFit="cover"
                  allowDownscaling
                />
              ) : null}
            </View>
            <Text numberOfLines={2} style={styles.cardTitle}>
              {item.name}
            </Text>
            <Text style={styles.cardMeta}>{item.count}</Text>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: { width: "48%" },
    cardMeta: { ...t("mono"), color: colors.textFaint },
    cardTitle: {
      ...t("small"),
      color: colors.text,
      lineHeight: 18,
      marginTop: spacing[2],
    },
    count: { ...t("mono"), color: colors.textSoft, marginEnd: spacing[3] },
    cover: {
      aspectRatio: 4 / 3,
      borderRadius: radii.md,
      overflow: "hidden",
    },
    coverImage: { height: "100%", width: "100%" },
    empty: {
      ...t("small"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[6],
      textAlign: "center",
    },
    grid: {
      gap: spacing[4],
      paddingBottom: spacing[6],
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
      minHeight: 48,
      paddingEnd: spacing[4],
      paddingStart: spacing[2],
      paddingTop: spacing[2],
    },
    headerBtn: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    mapChip: {
      borderRadius: 999,
      borderWidth: borders.hairline,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[1],
    },
    mapChipText: { ...t("mono") },
    row: { gap: spacing[4] },
    safe: { flex: 1 },
    title: { ...t("title"), color: colors.text, flex: 1 },
  });
