import { Feather } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { palette, tileFinish } from "@centraid/design";

import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { family, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme/resolve";
import type { PhotosScreenProps } from "../../navigation";

// Collection tints come from the shared 8-hue app palette (#686) rather than
// hand-picked hexes, so Photos drifts with the design system. The order below
// alternates warm and cool so neighbouring tiles never read as a run of one
// family; `tileFinish(_, "solid")` supplies the fill and the glyph ink, which
// is what keeps white marks legible on every hue in both schemes.
const TINTS = [
  palette.teal,
  palette.rose,
  palette.indigo,
  palette.amber,
  palette.violet,
  palette.forest,
  palette.ochre,
  palette.slate,
] as const;

/** Ink for anything drawn on a tint (all solid tiles share one glyph color). */
const ON_TINT = tileFinish(palette.teal, "solid").glyphColor;

const fill = (color: string): string =>
  tileFinish(color, "solid").backgroundColor;

/** FNV-1a — a stable tint per row id, so tiles don't reshuffle on re-sort. */
function tintFor(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return fill(TINTS[h % TINTS.length] ?? TINTS[0]);
}

// Fixed collections read best with a tint chosen for their meaning rather than
// hashed: people learn the colour of "Favorites" the way they learn its icon.
const CATEGORIES: Array<{ label: string; color: string }> = [
  { label: "Documents", color: fill(palette.slate) },
  { label: "Selfies", color: fill(palette.rose) },
  { label: "Videos", color: fill(palette.violet) },
  { label: "Food", color: fill(palette.amber) },
  { label: "Nature", color: fill(palette.forest) },
  { label: "Receipts", color: fill(palette.ochre) },
];

type Nav = PhotosScreenProps<"PhotosHome">["navigation"];

interface CollectionRowProps {
  color: string;
  icon: React.ReactNode;
  title: string;
  count: string;
  last?: boolean;
  onPress: () => void;
}

function CollectionRow({
  color,
  icon,
  title,
  count,
  last,
  onPress,
  styles,
  colors,
}: CollectionRowProps & {
  styles: Styles;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.row,
        last
          ? null
          : { borderBottomColor: colors.line, borderBottomWidth: 0.5 },
      ]}
    >
      <View style={[styles.rowTile, { backgroundColor: color }]}>{icon}</View>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.rowMeta, { color: colors.textFaint }]}>
          {count}
        </Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.textGhost} />
    </Pressable>
  );
}

export default function PhotosCollectionsView({
  navigation,
}: {
  navigation: Nav;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const collections = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection" }), [])
  );
  const faces = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.face_region" }), [])
  );
  const parties = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.party" }), [])
  );

  // People & pets: the confirmed parties that actually own a face region, in
  // face-count order. Names come from core.party; face_region carries only ids.
  const people = useMemo(() => {
    const counts = new Map<string, number>();
    for (const face of faces.rows) {
      const pid = face.confirmed_by_party_id ?? face.party_id;
      if (!pid) continue;
      const key = String(pid);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return parties.rows
      .map((party) => ({
        id: String(party.party_id),
        name: String(party.display_name ?? party.name ?? "Person"),
        count: counts.get(String(party.party_id)) ?? 0,
      }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }, [faces.rows, parties.rows]);

  const albums = collections.rows;

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.rowList}>
        <CollectionRow
          styles={styles}
          colors={colors}
          color={fill(palette.rose)}
          icon={<Feather name="heart" size={20} color={ON_TINT} />}
          title="Favorites"
          count="Your starred photos"
          onPress={() =>
            navigation.navigate("PhotoStateView", { mode: "favorites" })
          }
        />
        <CollectionRow
          styles={styles}
          colors={colors}
          color={fill(palette.indigo)}
          icon={<Feather name="clock" size={20} color={ON_TINT} />}
          title="Recently added"
          count="Newest first"
          onPress={() => navigation.navigate("PhotosLibrary")}
        />
        <CollectionRow
          styles={styles}
          colors={colors}
          color={fill(palette.teal)}
          icon={<Feather name="smartphone" size={20} color={ON_TINT} />}
          title="Screenshots"
          count="Captured on this phone"
          onPress={() => navigation.navigate("PhotosLibrary")}
        />
        <CollectionRow
          styles={styles}
          colors={colors}
          color={fill(palette.slate)}
          icon={<Feather name="archive" size={20} color={ON_TINT} />}
          title="Archive"
          count="Hidden from the timeline"
          last
          onPress={() =>
            navigation.navigate("PhotoStateView", { mode: "archive" })
          }
        />
      </View>

      <View style={styles.sectionHead}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          People &amp; pets
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.peopleRow}
      >
        {people.map((person) => (
          <View key={person.id} style={styles.person}>
            <View
              style={[styles.avatar, { backgroundColor: tintFor(person.id) }]}
            />
            <Text
              numberOfLines={1}
              style={[styles.personName, { color: colors.textSoft }]}
            >
              {person.name}
            </Text>
          </View>
        ))}
        <Pressable
          style={styles.person}
          onPress={() => navigation.navigate("FaceReview")}
          accessibilityLabel="Add a person"
        >
          <View style={[styles.avatarAdd, { borderColor: colors.lineStrong }]}>
            <Feather name="plus" size={20} color={colors.textFaint} />
          </View>
          <Text style={[styles.personName, { color: colors.textFaint }]}>
            Add
          </Text>
        </Pressable>
      </ScrollView>

      <View style={styles.sectionHead}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          Albums
        </Text>
        <Pressable
          style={styles.newAlbum}
          onPress={() => navigation.navigate("PhotosLibrary")}
          accessibilityLabel="New album"
        >
          <Feather name="plus" size={14} color={colors.accent} />
          <Text style={[styles.newAlbumText, { color: colors.accent }]}>
            New album
          </Text>
        </Pressable>
      </View>
      {albums.length ? (
        <View style={styles.albumGrid}>
          {albums.map((album) => (
            <Pressable
              key={album.__rowId}
              style={styles.album}
              onPress={() =>
                navigation.navigate("AlbumDetail", {
                  albumId: String(album.collection_id),
                })
              }
            >
              <View
                style={[
                  styles.albumTile,
                  {
                    backgroundColor: tintFor(
                      String(album.collection_id ?? album.__rowId)
                    ),
                  },
                ]}
              />
              <Text
                numberOfLines={1}
                style={[styles.albumTitle, { color: colors.text }]}
              >
                {String(album.name ?? "Album")}
              </Text>
              <Text style={[styles.albumMeta, { color: colors.textFaint }]}>
                {String(album.item_count ?? album.count ?? 0)} photos
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Text style={[styles.emptyAlbums, { color: colors.textFaint }]}>
          Group photos into an album to see it here.
        </Text>
      )}

      <View style={styles.sectionHead}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          Categories
        </Text>
      </View>
      <View style={styles.categoryGrid}>
        {CATEGORIES.map((category) => (
          <View
            key={category.label}
            style={[styles.category, { backgroundColor: category.color }]}
          >
            <View style={styles.categoryShade} />
            <Text style={styles.categoryLabel}>{category.label}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (
  _colors: ThemeColors
): ReturnType<typeof StyleSheet.create> =>
  StyleSheet.create({
    album: { width: "48%" },
    albumGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 14,
      justifyContent: "space-between",
      paddingHorizontal: 16,
    },
    albumMeta: { fontFamily: family.sansRegular, fontSize: 12, marginTop: 1 },
    albumTile: { aspectRatio: 1, borderRadius: 14 },
    albumTitle: { fontFamily: family.sansBold, fontSize: 14, marginTop: 9 },
    avatar: { borderRadius: 33, height: 66, width: 66 },
    avatarAdd: {
      alignItems: "center",
      borderRadius: 33,
      borderStyle: "dashed",
      borderWidth: 1,
      height: 66,
      justifyContent: "center",
      width: 66,
    },
    category: {
      aspectRatio: 1.1,
      borderRadius: 12,
      justifyContent: "flex-end",
      overflow: "hidden",
      width: "31%",
    },
    categoryGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      paddingHorizontal: 16,
    },
    categoryLabel: {
      color: ON_TINT,
      fontFamily: family.sansBold,
      fontSize: 12,
      margin: 9,
    },
    categoryShade: {
      ...StyleSheet.absoluteFill,
      backgroundColor: "rgba(0,0,0,.28)",
    },
    emptyAlbums: {
      fontFamily: family.sansRegular,
      fontSize: 13,
      paddingHorizontal: 16,
    },
    newAlbum: { alignItems: "center", flexDirection: "row", gap: 5 },
    newAlbumText: { fontFamily: family.sansMedium, fontSize: 13 },
    peopleRow: { gap: 14, paddingHorizontal: 16, paddingVertical: 2 },
    person: { alignItems: "center", gap: 7, width: 66 },
    personName: { fontFamily: family.sansMedium, fontSize: 11 },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 13,
      paddingVertical: 10,
    },
    rowList: { paddingHorizontal: 16 },
    rowMeta: { fontFamily: family.sansRegular, fontSize: 13, marginTop: 1 },
    rowText: { flex: 1, minWidth: 0 },
    rowTile: {
      alignItems: "center",
      borderRadius: 12,
      height: 48,
      justifyContent: "center",
      width: 48,
    },
    rowTitle: { fontFamily: family.sansRegular, fontSize: 15 },
    scroll: { paddingBottom: 24, paddingTop: 4 },
    sectionHead: {
      alignItems: "baseline",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingBottom: 12,
      paddingHorizontal: 16,
      paddingTop: 24,
    },
    sectionTitle: { fontFamily: family.sansBold, fontSize: 15 },
  });
