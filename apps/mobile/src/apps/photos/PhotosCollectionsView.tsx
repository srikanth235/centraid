// The Albums destination of the claimed band (Photos v4 §3.1, §14).
//
// This screen used to also serve People, but People is now its own band
// destination (`PhotosPeopleView.tsx`, wired in `PhotosHome.tsx`'s
// `destination` switch) rather than a section grafted onto Albums — the band
// item is literally labelled "People", and a member landing on a screen
// titled "Albums" that happens to also show people is exactly the kind of
// mislabelled destination this rewrite exists to remove.
//
// Two more things changed here for v4 beyond the type ramp:
//
//   1. The "Categories" grid is gone. It was six solid tint tiles standing for
//      shelves that do not exist in this product (Documents, Selfies, Food, …)
//      — six of the loudest elements on the page, each one a promise the vault
//      could not keep. A view is allowed one filled element (§18); a made-up
//      shelf is allowed none.
//   2. "Recently added", "Screenshots" and "Archive" rows that used to live
//      above the People section are gone too, for the same reason: none of
//      the three is in the handoff's shelf table (README:212-219), and all
//      three navigated to `PhotosLibrary` regardless of what they claimed to
//      open — a second instance of the same lying-row defect the Categories
//      grid was removed for. Favorites survives because it IS in the shelf
//      table and it DOES navigate to its own destination.
//   3. Grounds are honest. An album's identity is its cover photograph, and no
//      cover has loaded on this screen — so an album tile takes the `--skel`
//      ground every unloaded tile in this app takes, not a decorative tint.

import React, { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";

type Nav = PhotosScreenProps<"PhotosHome">["navigation"];

interface CollectionRowProps {
  icon: string;
  title: string;
  meta: string;
  last?: boolean;
  onPress: () => void;
}

function CollectionRow({
  icon,
  title,
  meta,
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
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${meta}`}
      onPress={onPress}
      style={[styles.row, last ? null : styles.rowRule]}
    >
      <View style={styles.rowTile}>
        <Icon name={icon} size={19} color={colors.textSoft} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowMeta}>{meta}</Text>
      </View>
      <Icon name="chevron-right" size={18} color={colors.textGhost} />
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
          icon="heart"
          title="Favorites"
          meta="Photographs you starred"
          last
          onPress={() =>
            navigation.navigate("PhotoStateView", { mode: "favorites" })
          }
        />
      </View>

      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>Albums</Text>
        <Pressable
          style={styles.newAlbum}
          onPress={() => navigation.navigate("PhotosLibrary")}
          accessibilityRole="button"
          accessibilityLabel="New album"
        >
          <Icon name="plus" size={14} color={colors.text} />
          <Text style={styles.newAlbumText}>New album</Text>
        </Pressable>
      </View>
      {albums.length ? (
        <View style={styles.albumGrid}>
          {albums.map((album) => (
            <Pressable
              key={album.__rowId}
              accessibilityRole="button"
              accessibilityLabel={`Open album ${String(album.name ?? "Album")}`}
              style={styles.album}
              onPress={() =>
                navigation.navigate("AlbumDetail", {
                  albumId: String(album.collection_id),
                })
              }
            >
              {/* The tile's ground before its cover decodes — the same `--skel`
                  every unloaded tile in this app stands on. */}
              <View style={styles.albumTile} />
              <Text numberOfLines={1} style={styles.albumTitle}>
                {String(album.name ?? "Album")}
              </Text>
              <Text style={styles.albumMeta}>
                {String(album.item_count ?? album.count ?? 0)} photographs
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Text style={styles.sectionEmpty}>
          No albums yet. An album refers to a photograph where it lives; it
          never moves or copies anything.
        </Text>
      )}
    </ScrollView>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    album: { width: "48%" },
    albumGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing[3],
      justifyContent: "space-between",
      paddingHorizontal: spacing[4],
    },
    albumMeta: { ...t("mono"), color: colors.textFaint },
    albumTile: {
      aspectRatio: 1,
      backgroundColor: colors.skel,
      borderRadius: 12,
    },
    albumTitle: {
      ...t("smallStrong"),
      color: colors.text,
      marginTop: spacing[2],
    },
    newAlbum: { alignItems: "center", flexDirection: "row", gap: spacing[1] },
    newAlbumText: { ...t("control"), color: colors.text },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[3],
      minHeight: 56,
    },
    rowList: { paddingHorizontal: spacing[4] },
    rowMeta: { ...t("small"), color: colors.textFaint },
    rowRule: {
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
    },
    rowText: { flex: 1, minWidth: 0 },
    rowTile: {
      alignItems: "center",
      backgroundColor: colors.bgSunken,
      borderColor: colors.line,
      borderRadius: 12,
      borderWidth: borders.hairline,
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    rowTitle: { ...t("body"), color: colors.text },
    scroll: { paddingBottom: spacing[5], paddingTop: spacing[1] },
    sectionEmpty: {
      ...t("small"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
    },
    sectionHead: {
      alignItems: "baseline",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingBottom: spacing[3],
      paddingHorizontal: spacing[4],
      paddingTop: spacing[5],
    },
    sectionTitle: { ...t("eyebrow"), color: colors.textSoft },
  });
