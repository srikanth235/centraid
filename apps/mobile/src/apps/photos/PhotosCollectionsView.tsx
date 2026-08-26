// Collections — the landing surface of Photos, and NOT "Albums": every shelf
// gets a named section over a horizontal rail. The section model is pure, in
// `photos-collections.ts`.
//
// AN EMPTY SECTION STILL RENDERS: its sentence names what would appear there and
// why it has not — the product explaining itself, not a placeholder.

import { Image } from "expo-image";
import React, { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { radii } from "@centraid/design";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useImageFallback } from "../../kit/media/use-image-fallback";
import { borders, pageMargin, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import CollectionShelfBody from "./CollectionShelfBody";
import { buildCollectionSections } from "./photos-collections";
import type {
  CollectionSection,
  CollectionSectionKey,
  CollectionTile,
} from "./photos-collections";
import { placeCardKey } from "./places-model";
import { onThisDay } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";

type Nav = PhotosScreenProps<"PhotosHome">["navigation"];

/** Two-and-a-bit tiles on the narrowest phone: the cut third says the rail scrolls. */
const TILE = 132;

function RailTile({
  tile,
  onPress,
  styles,
}: {
  tile: CollectionTile;
  onPress: () => void;
  styles: Styles;
}): React.JSX.Element {
  // `?variant=thumb` 404s until the gateway's preview backstop has run.
  const media = useImageFallback(tile.uri ?? "", tile.originalUri, tile.id);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tile.label ?? "Open"}
      onPress={onPress}
      style={styles.tile}
    >
      <View style={[styles.cover, tile.round ? styles.coverRound : null]}>
        {tile.uri && !media.failed ? (
          <Image
            source={{ uri: media.source }}
            recyclingKey={media.recyclingKey}
            onLoad={media.handleLoad}
            onError={media.handleError}
            contentFit="cover"
            style={styles.coverImage}
          />
        ) : null}
        {/* A square tile burns its label in; a caption below would make rows
            different heights. A circle clips that band, so a round tile's name
            goes under it instead. */}
        {tile.label && !tile.round ? (
          <View style={styles.labelWrap}>
            <Text numberOfLines={1} style={styles.label}>
              {tile.label}
            </Text>
          </View>
        ) : null}
      </View>
      {tile.label && tile.round ? (
        <Text numberOfLines={1} style={styles.labelUnder}>
          {tile.label}
        </Text>
      ) : null}
    </Pressable>
  );
}

function Section({
  section,
  collapsed,
  onOpen,
  onAction,
  onToggleCollapse,
  styles,
  colors,
}: {
  section: CollectionSection;
  collapsed: boolean;
  onOpen: (tile?: CollectionTile) => void;
  onAction: () => void;
  onToggleCollapse: () => void;
  styles: Styles;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        {/* Title plus chevron means "go in". Collapse is a separate control
            below, never a second meaning on this target. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            section.count === undefined
              ? `Open ${section.title}`
              : `Open ${section.title}, ${section.count}`
          }
          onPress={() => onOpen()}
          style={styles.headOpen}
        >
          <Text style={styles.headTitle}>{section.title}</Text>
          <Icon name="chevron-right" size={18} color={colors.textFaint} />
        </Pressable>
        <View style={styles.headSpacer} />
        {section.count === undefined ? null : (
          <Text style={styles.headCount}>{section.count.toLocaleString()}</Text>
        )}
        {/* Points at the rail it governs, never a second `chevron-right`. The
            registry has no `ChevronUp`, so the fold rotates `chevron-down`. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            collapsed ? `Expand ${section.title}` : `Collapse ${section.title}`
          }
          accessibilityState={{ expanded: !collapsed }}
          onPress={onToggleCollapse}
          style={styles.collapseBtn}
        >
          <View style={collapsed ? styles.collapseIconFlipped : undefined}>
            <Icon name="chevron-down" size={18} color={colors.textFaint} />
          </View>
        </Pressable>
      </View>

      <CollectionShelfBody
        action={section.action}
        collapsed={collapsed}
        empty={section.empty}
        emptyActionStyle={styles.emptyAction}
        emptyActionTextStyle={styles.emptyActionText}
        emptyStyle={styles.empty}
        emptyTextStyle={styles.emptyText}
        hasTiles={section.tiles.length > 0}
        onAction={onAction}
        title={section.title}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.rail}
        >
          {section.tiles.map((tile) => (
            <RailTile
              key={tile.id}
              tile={tile}
              onPress={() => onOpen(tile)}
              styles={styles}
            />
          ))}
        </ScrollView>
      </CollectionShelfBody>
    </View>
  );
}

export default function PhotosCollectionsView({
  navigation,
  collapsed,
  onToggleSection,
}: {
  navigation: Nav;
  /** SESSION state, and a display fold — never a filter. Owned by
   *  `PhotosHome.tsx` (#712), which hosts the Show All / Collapse All menu; this
   *  file keeps no `useState` for it. */
  collapsed: ReadonlySet<CollectionSectionKey>;
  onToggleSection: (key: CollectionSectionKey) => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { assets } = usePhotoTimeline();

  const collections = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection" }), [])
  );
  const entries = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection_entry" }), [])
  );
  const places = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.place" }), [])
  );
  const faces = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.face_region" }), [])
  );
  // A face row carries a party ID, never a name; `PhotosPeopleView` resolves it
  // the same way, and the two must not disagree.
  const parties = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.party" }), [])
  );

  const sections = useMemo(() => {
    // `target_id`, not `asset_id`: collection entries are polymorphic, and the
    // photographs-only column yields every album empty.
    const albums = collections.rows.map((row) => ({
      collectionId: String(row.collection_id),
      name: String(row.name ?? "Album"),
      assetIds: entries.rows
        .filter(
          (entry) => String(entry.collection_id) === String(row.collection_id)
        )
        .map((entry) => String(entry.target_id)),
      // The member's own key-photo choice, preferred over the newest member (#721).
      ...(row.cover_content_id
        ? { coverContentId: String(row.cover_content_id) }
        : {}),
    }));
    // Only CONFIRMED faces make a person — a proposed region is the enricher's
    // candidate, not somebody the member has named.
    const facesByParty = new Map<string, string[]>();
    for (const face of faces.rows) {
      if (!face.confirmed_by_party_id) continue;
      const key = String(face.confirmed_by_party_id);
      const list = facesByParty.get(key) ?? [];
      list.push(String(face.asset_id));
      facesByParty.set(key, list);
    }
    const byParty = new Map<string, { name: string; assetIds: string[] }>();
    for (const party of parties.rows) {
      const assetIds = facesByParty.get(String(party.party_id));
      if (!assetIds?.length) continue;
      byParty.set(String(party.party_id), {
        name: String(party.display_name ?? party.name ?? "Unnamed"),
        assetIds,
      });
    }
    return buildCollectionSections({
      assets,
      albums,
      places: places.rows.flatMap((row) => {
        const key = placeCardKey(row);
        return key === null
          ? []
          : [
              {
                placeId: String(row.place_id),
                key,
                name: String(row.name ?? "Place"),
              },
            ];
      }),
      people: [...byParty.entries()].map(([partyId, entry]) => ({
        partyId,
        ...entry,
      })),
      memories: onThisDay(assets),
    });
  }, [
    assets,
    collections.rows,
    entries.rows,
    faces.rows,
    parties.rows,
    places.rows,
  ]);

  /** Closed key union, so a section with no destination fails to typecheck here.
   *  Absent `tile` means the HEADING was pressed. */
  const open = (key: CollectionSectionKey, tile?: CollectionTile): void => {
    switch (key) {
      case "memories":
        if (tile) navigation.navigate("PhotoLightbox", { assetId: tile.id });
        else navigation.navigate("PhotosMemories");
        break;
      case "albums":
        if (tile) navigation.navigate("AlbumDetail", { albumId: tile.id });
        else navigation.navigate("PhotosLibrary");
        break;
      case "people":
        if (tile)
          navigation.navigate("PhotoStateView", {
            mode: "person",
            partyId: tile.id,
            personName: tile.label ?? "Unnamed",
          });
        else navigation.navigate("PhotosPeople");
        break;
      case "places":
        if (tile)
          navigation.navigate("PlaceDetail", {
            placeKey: tile.id,
            placeName: tile.label ?? "Place",
          });
        else navigation.navigate("PlacesView");
        break;
      case "favorites":
        navigation.navigate("PhotoStateView", { mode: "favorites" });
        break;
      case "videos":
        // A filter over the same shelf screen, never a bespoke grid (#721).
        navigation.navigate("PhotoStateView", { mode: "videos" });
        break;
      case "duplicates":
        navigation.navigate("DuplicatesShelf");
        break;
      case "trash":
        navigation.navigate("PhotoStateView", { mode: "trash" });
        break;
      default: {
        const exhaustive: never = key;
        throw new Error(`Unhandled section: ${String(exhaustive)}`);
      }
    }
  };

  return (
    // No header row of its own (#712): the Show All / Collapse All menu lives in
    // `PhotosHome.tsx`'s header slot. Only the per-section chevrons stay here.
    <ScrollView
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
    >
      {sections.map((section) => (
        <Section
          key={section.key}
          section={section}
          collapsed={collapsed.has(section.key)}
          styles={styles}
          colors={colors}
          onOpen={(tile) => open(section.key, tile)}
          onAction={() => open(section.key)}
          onToggleCollapse={() => onToggleSection(section.key)}
        />
      ))}
    </ScrollView>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    collapseBtn: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 32,
    },
    collapseIconFlipped: { transform: [{ rotate: "180deg" }] },
    cover: {
      backgroundColor: colors.skel,
      borderRadius: radii.md,
      height: TILE,
      overflow: "hidden",
      width: TILE,
    },
    coverImage: { height: "100%", width: "100%" },
    coverRound: { borderRadius: TILE / 2 },
    empty: {
      backgroundColor: colors.bgSunken,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      gap: spacing[3],
      marginHorizontal: pageMargin,
      padding: spacing[4],
    },
    emptyAction: {
      alignItems: "center",
      alignSelf: "flex-start",
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      justifyContent: "center",
      minHeight: 34,
      paddingHorizontal: spacing[4],
    },
    emptyActionText: { ...t("control"), color: colors.text },
    emptyText: { ...t("small"), color: colors.textSoft },
    head: {
      alignItems: "center",
      flexDirection: "row",
      paddingBottom: spacing[3],
      paddingHorizontal: pageMargin,
    },
    headCount: { ...t("mono"), color: colors.textFaint },
    headOpen: { alignItems: "center", flexDirection: "row", gap: spacing[1] },
    headSpacer: { flex: 1 },
    // No primary section: choosing one would choose for the member.
    headTitle: { ...t("title"), color: colors.text },
    label: { ...t("smallStrong"), color: colors.onStage },
    labelUnder: {
      ...t("smallStrong"),
      color: colors.text,
      paddingTop: spacing[2],
      textAlign: "center",
    },
    labelWrap: {
      backgroundColor: colors.scrim,
      bottom: 0,
      insetInlineEnd: 0,
      insetInlineStart: 0,
      paddingHorizontal: spacing[2],
      paddingVertical: spacing[2],
      position: "absolute",
    },
    rail: { gap: spacing[2], paddingHorizontal: pageMargin },
    scroll: { paddingBottom: spacing[6], paddingTop: spacing[3] },
    section: { paddingTop: spacing[5] },
    tile: { width: TILE },
  });
