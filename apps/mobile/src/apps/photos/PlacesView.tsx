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

import { Text } from "../../kit/components/NativeText";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { imageSource } from "../../kit/media/media-source";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import PhotosScreen from "./PhotosScreen";
import { placeCards } from "./places-model";
import { tileGround } from "./tile-overlays";
import { usePhotoTimeline } from "./timeline-source";

// Places group by rounding each capture's coordinates to one decimal (roughly
// 11km), which is also the key `PlaceDetail` filters by — so a card and the
// screen it opens cannot disagree about which photographs are "here". The
// grouping itself lives in `places-model.ts`, beside the map's own; see that
// file's header for why the two group differently on purpose.

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
  const cards = useMemo(
    () => placeCards(assets, places.rows),
    [assets, places.rows]
  );

  return (
    // The band, via the shell (issue #712 P8). This screen used to draw a bare
    // `SafeAreaView` with a back chevron and NO band, so the only way out of
    // Photos from here was the OS gesture — the §F dead end `PhotosScreen`
    // exists to make unrepresentable. `current="more"` because the More
    // sheet's Places row is how a member arrives.
    <PhotosScreen current="more">
      <View style={styles.header}>
        {/* No back chevron. It was this screen's ONLY exit; the band below now
            provides two (the Places row's siblings, and the frame's Home
            capsule), and a third spelling of "leave" in the head is the kind
            of duplicate affordance §F's one-navigation rule forbids — the same
            call the Backup screen made when it gained the band. */}
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
            {/* THE GROUND (issue #712 P9). `--skel` is defined as "the ground
                a tile paints BEFORE its bytes arrive" (packages/design/src/
                roles.ts) — it is the absence, not the surface. This card used
                to pin it forever, so a place whose cover had decoded still
                stood on the placeholder. `tileGround` is the app's own
                contract for exactly this (PhotoTile.tsx): skel while there is
                nothing to show, `--bg-sunken` once there is. */}
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
      // 12, not `radii.md` (7) — the shelf-card radius the handoff states and
      // the one `PhotosCollectionsView`'s album tile already uses. A shelf of
      // cards has one corner, and this was the only card cutting a tighter one.
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
