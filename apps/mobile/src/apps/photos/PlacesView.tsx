// Places, cards first (Photos v4 handoff §14, §18); the count is PLACES,
// never "N of M geotagged photographs".

import { Image } from "expo-image";
import React, { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { imageSource } from "../../kit/media/media-source";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { TEST_ID_PREFIXES, TEST_IDS } from "../../kit/test-ids";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import { PHOTO_ENTITY_READS } from "./photo-entity-reads";
import PhotosScreen from "./PhotosScreen";
import { noLocationCard, placeCards } from "./places-model";
import { tileGround } from "./tile-overlays";
import { usePhotoTimeline } from "./timeline-source";

// Cards group by one-decimal rounding (~11km) — the `PlaceDetail` key;
// places-model.ts differs from the map on purpose.

export default function PlacesView({
  navigation,
}: PhotosScreenProps<"PlacesView">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const places = useReplicaQuery("photos", PHOTO_ENTITY_READS.places);
  const { assets } = usePhotoTimeline();
  const cards = useMemo(
    () => placeCards(assets, places.rows),
    [assets, places.rows]
  );
  // THE TRAILING CARD (#816): photos with no place; reachable, NOT counted
  // as a place.
  const shelf = useMemo(() => {
    const bucket = noLocationCard(assets);
    return bucket ? [...cards, bucket] : cards;
  }, [assets, cards]);

  return (
    // The band via the shell (#712): a bare SafeAreaView leaves the OS
    // gesture as the only exit. current="more" = arrived via More.
    <PhotosScreen current="more">
      <View style={styles.header} testID={TEST_IDS.places.shelf}>
        {/* No back chevron: two exits already; a third breaks §F's rule. */}
        <Text style={styles.title}>Places</Text>
        {/* Places · N — shelf size, mono (proto:3939); "N of M" belongs to
            the map. */}
        <Text style={styles.count}>Places · {cards.length}</Text>
        <Pressable
          accessibilityLabel="Open map"
          accessibilityRole="button"
          testID={TEST_IDS.places.mapOpen}
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
        data={shelf}
        keyExtractor={(item) => item.id}
        numColumns={2}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.row}
        ListEmptyComponent={
          <Text style={styles.empty}>
            No places yet — a place is something a photograph carries, or does
            not.
          </Text>
        }
        renderItem={({ item, index }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${item.count} photographs`}
            style={styles.card}
            testID={`${TEST_ID_PREFIXES.placesCard}${index}`}
            onPress={() =>
              navigation.navigate("PlaceDetail", {
                placeKey: item.id,
                placeName: item.name,
              })
            }
          >
            {/* THE GROUND (#712): `--skel` before bytes arrive;
                tileGround (PhotoTile.tsx) is the contract. */}
            <View
              style={[
                styles.cover,
                {
                  backgroundColor: tileGround(
                    Boolean(item.coverUri),
                    colors.skel,
                    colors.bgSunken
                  ),
                },
              ]}
            >
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
    </PhotosScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: { width: "48%" },
    cardMeta: { ...t("mono"), color: colors.textFaint },
    cardTitle: {
      ...t("small"),
      color: colors.text,
      marginTop: spacing[2],
    },
    count: { ...t("mono"), color: colors.textSoft, marginEnd: spacing[3] },
    cover: {
      aspectRatio: 4 / 3,
      // radii.lg (7): the shelf-card radius the handoff states.
      borderRadius: radii.lg,
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
      paddingStart: spacing[4] - 2,
      paddingTop: spacing[2],
    },
    mapChip: {
      borderRadius: radii.pill,
      borderWidth: borders.hairline,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[1],
    },
    mapChipText: { ...t("mono") },
    row: { gap: spacing[4] },
    title: { ...t("title"), color: colors.text, flex: 1 },
  });
