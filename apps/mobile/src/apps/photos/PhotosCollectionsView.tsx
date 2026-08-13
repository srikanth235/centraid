// Collections — the shape of a member's library, on one page.
//
// This is the landing surface of Photos now, and it replaces the destination
// that used to be called "Albums". Two things were wrong with that name: it
// described one section of what the screen showed, and the screen it named was
// a two-column grid of album tiles with a Favorites row bolted above it, while
// every other shelf this product has — People, Places, Duplicates, Trash —
// was reachable only from the bottom row of a sheet behind a **More** tab. A
// member could use Photos for a month without learning that Places existed.
//
// So the page is the shelves, all of them, each one a named section over a
// horizontal rail of covers. The section model — including what each section
// says when it is empty — is in `photos-collections.ts` and is pure; this file
// is its frame and its navigation.
//
// AN EMPTY SECTION STILL RENDERS. That is the part worth defending: on a fresh
// vault most of this page is empty cards, and each card names what would
// appear there and why it has not. The alternative — showing only sections
// that already have something in them — makes the first week of a vault a
// screen that silently grows features, and a member who never favourites a
// photograph never finds out that Favorites is where they would go. The
// sentences are the product explaining itself; they are not placeholders.
//
// The rail is the tile-with-a-burned-in-label form, and the label is inside
// the tile rather than under it because these covers are IDENTITY (which
// album, which person) rather than content — the same reason the vault mark
// carries its initial and not a caption.

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
import { onThisDay } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";

type Nav = PhotosScreenProps<"PhotosHome">["navigation"];

/** The rail's tile. 132 wide is two-and-a-bit tiles on the narrowest phone
 *  this app supports — enough that the third is visibly cut, which is what
 *  tells a member the rail scrolls without a chevron saying so. */
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
  // The derivative-then-original ladder, same as every other surface that
  // draws a replica photograph: `?variant=thumb` 404s until the gateway's
  // preview backstop has run, and the original is sitting whole in CAS.
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
        {/* A SQUARE tile burns its label into the cover, lower-left, over a
            scrim: a caption below would make the rail's rows different heights
            the moment one name wrapped.

            A ROUND one cannot — the label band is a rectangle, and the circle
            clips it, so "Owner" rendered as "wner" with its left third cut
            off. A person's name goes UNDER the circle instead, centred, which
            is also where iOS puts it. */}
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
        {/* "Open this shelf" keeps the verb it always had — title plus the
            chevron pointing INTO the section. Collapse is a second, separate
            control (below) rather than a second meaning bolted onto this
            same tap target, per the header comment on `PhotosCollectionsView`
            below: a member who has learned "tap the row to go in" must not
            discover one day that the same tap now only folds the rail. */}
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
        {/* The collapse affordance: a chevron that points at the rail it
            governs (down when the rail shows, and rotated to point up once
            it is folded away) rather than a second `chevron-right`, so it
            cannot be mistaken for a second way to open the shelf. There is no
            `ChevronUp` glyph in the shared registry, so the fold is drawn by
            rotating the one `chevron-down` glyph 180° instead of adding a
            near-duplicate icon. */}
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
  /** Per-section collapse — SESSION state, not a member preference: unlike
   *  the rung (`photos-rungs.ts`), which reads the same everywhere and is
   *  worth a durable write, which shelves are folded is a reading posture
   *  for the one visit, and this repo has no member-preference plane to
   *  spend on it (see `photos-library-menu.ts`'s header for the same
   *  argument about the Library filter). A collapsed section is still IN the
   *  set — its heading and count still render — so this is a display fold,
   *  never a filter.
   *
   *  OWNED BY `PhotosHome.tsx` now, not this file (issue #712): the page's
   *  trailing `···` chip that opens Show All / Collapse All moved into the
   *  header row those two commands share with Library's Sliders chip, so the
   *  state they act on had to move with it — a menu in one file driving a
   *  `useState` in another would drift the moment either side changed on its
   *  own. The per-section chevrons below stayed exactly where they are; they
   *  just read and write the state through these two props now instead of a
   *  local `useState`. */
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
  // A face row carries a party ID, never a name — the name lives on the party.
  // `PhotosPeopleView` resolves it the same way, and the two must not disagree
  // about who is in the member's library.
  const parties = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.party" }), [])
  );

  const sections = useMemo(() => {
    // `target_id`, not `asset_id`: a collection entry is polymorphic
    // (core_collection_entry carries target_type/target_id), and reading the
    // column a photographs-only mind expects yields every album empty with
    // nothing to show for it.
    const albums = collections.rows.map((row) => ({
      collectionId: String(row.collection_id),
      name: String(row.name ?? "Album"),
      assetIds: entries.rows
        .filter(
          (entry) => String(entry.collection_id) === String(row.collection_id)
        )
        .map((entry) => String(entry.target_id)),
      // Issue #721 B5: the member's own key-photo choice, straight off the
      // collection row — `chosenCover` (`photos-collections.ts`) is what
      // turns this into a tile, in preference to the newest member.
      ...(row.cover_content_id
        ? { coverContentId: String(row.cover_content_id) }
        : {}),
    }));
    // Only CONFIRMED faces make a person: a proposed region is the enricher's
    // candidate, and a candidate is not somebody the member has said is in
    // their library. `confirmed_by_party_id` is the column the schema pins to
    // `review_state = 'confirmed'`, so either reads the same answer.
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
      places: places.rows.map((row) => ({
        placeId: String(row.place_id),
        name: String(row.name ?? "Place"),
      })),
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

  /**
   * One switch over the closed key union: a section added to the model
   * without a destination fails to typecheck right here.
   *
   * `tile` absent means the HEADING was pressed — "show me all of these".
   * Favorites/Trash have no such destination and say so by opening the
   * tile's own photograph instead (they reach their shelf either way via
   * the tile, or PhotoStateView`'s own filter). Memories DOES have one now
   * (issue #724 W7, `MemoriesView.tsx`): the heading opens the full surface
   * (On this day, Trips, Similar moments), and a tile keeps opening straight
   * to the photograph it already did.
   */
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
        // People is off the band (issue #712) — the heading pushes the roster
        // route directly rather than a `PhotosHome` destination that no
        // longer exists.
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
        // Same door as Favorites (issue #721 B3): a filter over the same
        // shelf screen, not a bespoke grid — `PhotoStateView` already knows
        // how to be "the timeline, filtered", and Videos is nothing else.
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
    // No header row of its own anymore (issue #712). This page used to draw
    // a second trailing `···` chip here, below the real "Photos" header
    // (`PhotosHome.tsx`) — two stacked trailing controls where iOS Photos
    // has exactly one. That chip's menu (Show All / Collapse All) moved into
    // the SAME header slot Library's Sliders chip uses, scoped to whichever
    // destination is current; see `PhotosHome.tsx`'s `menuGroups` comment.
    // Only the per-section fold chevrons stay here — they act on `collapsed`
    // and `onToggleSection`, the two props that now own what used to be this
    // file's own `useState`.
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
    // The fold: same 44pt slot height as every other header control in this
    // app (`PhotosHome.styles.ts`'s `headerBtn`), so the row's own touch
    // targets read as a matched pair rather than one control being an
    // afterthought.
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
    // The "open this shelf" tap target: title plus its chevron, exactly the
    // pair that always meant "go in" — now its own Pressable so the collapse
    // control beside it (`collapseBtn`) can be a second, distinct target
    // rather than a second meaning layered onto this one.
    headOpen: { alignItems: "center", flexDirection: "row", gap: spacing[1] },
    headSpacer: { flex: 1 },
    // The section name is the loudest thing in its own band, and every band
    // looks the same: this page has no primary, because choosing one would be
    // choosing for the member which of their own shelves matters.
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
