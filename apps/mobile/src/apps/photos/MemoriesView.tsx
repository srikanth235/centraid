// Memories, full screen (issue #724 W7, "Memories v0").
//
// Reached from Collections' "Memories" heading (`PhotosCollectionsView.tsx`'s
// `open()`), which used to have nowhere to send a heading tap because no
// "all memories" surface existed. Now one does: three sections — On this
// day, Trips, Similar moments — read straight off the vault's
// `media.memory` / `media.memory_member` projection (`memories-model.ts`
// does the pure grouping; this file is only its frame).
//
// BROWSE ONLY, ON PURPOSE. Unlike `DuplicatesShelf.tsx`, this screen has no
// selection mode and no batch actions — a memory is something you look at,
// not something you triage. A tile tap opens the lightbox, full stop.
//
// HONEST EMPTY STATE. When every section comes back empty
// (`hasNoMemories`), the screen shows one explainer sentence instead of three
// empty shelves — the same law `photos-collections.ts`'s Memories shelf has
// always kept, extended to cover Trips and Similar moments too.

import React, { useMemo } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import { justify } from "./justify";
import {
  buildMemoriesModel,
  hasNoMemories,
  tripDateLabel,
  yearsAgo,
} from "./memories-model";
import type {
  MemoryYearGroup,
  RawMemoryMemberRow,
  RawMemoryRow,
  SimilarMemory,
  TripMemory,
} from "./memories-model";
import { usePhotosRung } from "./photos-rung-store";
import { rungHeight } from "./photos-rungs";
import { useVaultFacts } from "./photos-vaults";
import PhotosScreen from "./PhotosScreen";
import PhotoTile from "./PhotoTile";
import type { PhotoAsset } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";

/** No trip, on-this-day year, or similar moment ever surfaces below this
 *  many photographs to browse — reads oddly small otherwise, and the point
 *  of a rail is that it can be tapped open for the rest. */
const RAIL_PREVIEW_LIMIT = 30;

const NOTHING_YET =
  "Memories appear here on their own: a day that has an earlier year behind it, a run of days away from home, or a burst of near-identical photographs. Nothing is generated — they are your own photographs, noticed.";

function TileRail({
  assets,
  onOpen,
}: {
  assets: readonly PhotoAsset[];
  onOpen: (asset: PhotoAsset) => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [rung] = usePhotosRung();
  const vaults = useVaultFacts();
  const { width } = useWindowDimensions();
  const content = width - spacing[4] * 2;
  const rows = useMemo(
    () =>
      justify(
        assets.slice(0, RAIL_PREVIEW_LIMIT),
        content,
        rungHeight(rung, "phone")
      ),
    [assets, content, rung]
  );
  return (
    <>
      {rows.map((tiles, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {tiles.map((tile) => (
            <PhotoTile
              key={tile.asset.id}
              asset={tile.asset}
              width={tile.width}
              height={tile.height}
              rung={rung}
              selected={false}
              selecting={false}
              vaults={vaults}
              onOpen={onOpen}
              onSelect={onOpen}
            />
          ))}
        </View>
      ))}
    </>
  );
}

function SectionHeading({
  title,
  styles,
}: {
  title: string;
  styles: Styles;
}): React.JSX.Element {
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

function OnThisDayYearBlock({
  group,
  now,
  onOpen,
  styles,
}: {
  group: MemoryYearGroup;
  now: Date;
  onOpen: (asset: PhotoAsset) => void;
  styles: Styles;
}): React.JSX.Element {
  const ago = yearsAgo(group.year, now);
  return (
    <View style={styles.block}>
      <Text style={styles.blockTitle}>
        {ago === 1 ? "1 year ago" : `${ago} years ago`}
      </Text>
      <TileRail assets={group.assets} onOpen={onOpen} />
    </View>
  );
}

function TripBlock({
  trip,
  onOpen,
  styles,
}: {
  trip: TripMemory;
  onOpen: (asset: PhotoAsset) => void;
  styles: Styles;
}): React.JSX.Element {
  const dateLabel = tripDateLabel(trip);
  return (
    <View style={styles.block}>
      <Text style={styles.blockTitle} numberOfLines={1}>
        {trip.placeName ?? "Away from home"}
      </Text>
      {dateLabel ? <Text style={styles.blockMeta}>{dateLabel}</Text> : null}
      <TileRail assets={trip.assets} onOpen={onOpen} />
    </View>
  );
}

function SimilarBlock({
  group,
  onOpen,
  styles,
}: {
  group: SimilarMemory;
  onOpen: (asset: PhotoAsset) => void;
  styles: Styles;
}): React.JSX.Element {
  return (
    <View style={styles.block}>
      <Text style={styles.blockTitle}>
        {group.assets.length} similar photographs
      </Text>
      <TileRail assets={group.assets} onOpen={onOpen} />
    </View>
  );
}

export default function MemoriesView({
  navigation,
}: PhotosScreenProps<"PhotosMemories">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { assets } = usePhotoTimeline();

  const memoryRows = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.memory", limit: 2000 }), [])
  );
  const memberRows = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.memory_member", limit: 20_000 }), [])
  );
  const places = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.place" }), [])
  );

  const placeNames = useMemo(
    () =>
      new Map(
        places.rows.map((row) => [
          String(row.place_id),
          String(row.name ?? "Place"),
        ])
      ),
    [places.rows]
  );

  // `now` is stable for the screen's lifetime — recomputing it per render
  // would let "today" silently shift under a member mid-scroll if the app
  // happened to cross midnight while this screen was open.
  const now = useMemo(() => new Date(), []);

  const model = useMemo(
    () =>
      buildMemoriesModel(
        memoryRows.rows as readonly RawMemoryRow[],
        memberRows.rows as readonly RawMemoryMemberRow[],
        assets,
        placeNames,
        now
      ),
    [memoryRows.rows, memberRows.rows, assets, placeNames, now]
  );

  const open = (asset: PhotoAsset): void => {
    navigation.navigate("PhotoLightbox", { assetId: asset.id });
  };

  const empty = hasNoMemories(model);

  return (
    <PhotosScreen current="more">
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to Photos"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
        >
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          Memories
        </Text>
      </View>
      <ReplicaStatusBar />
      <ScrollView contentContainerStyle={styles.body}>
        {empty ? (
          <Text style={styles.note}>{NOTHING_YET}</Text>
        ) : (
          <>
            {model.onThisDay ? (
              <View style={styles.section}>
                <SectionHeading title="On this day" styles={styles} />
                {model.onThisDay.years.map((group) => (
                  <OnThisDayYearBlock
                    key={group.year}
                    group={group}
                    now={now}
                    onOpen={open}
                    styles={styles}
                  />
                ))}
              </View>
            ) : null}
            {model.trips.length > 0 ? (
              <View style={styles.section}>
                <SectionHeading title="Trips" styles={styles} />
                {model.trips.map((trip) => (
                  <TripBlock
                    key={trip.memoryId}
                    trip={trip}
                    onOpen={open}
                    styles={styles}
                  />
                ))}
              </View>
            ) : null}
            {model.similar.length > 0 ? (
              <View style={styles.section}>
                <SectionHeading title="Similar moments" styles={styles} />
                {model.similar.map((group) => (
                  <SimilarBlock
                    key={group.memoryId}
                    group={group}
                    onOpen={open}
                    styles={styles}
                  />
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </PhotosScreen>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    block: { marginBottom: spacing[5] },
    blockMeta: {
      ...t("small"),
      color: colors.textFaint,
      marginBottom: spacing[2],
      paddingHorizontal: spacing[4],
    },
    blockTitle: {
      ...t("bodyStrong"),
      color: colors.text,
      marginBottom: spacing[1],
      paddingHorizontal: spacing[4],
    },
    body: { paddingBottom: spacing[6] },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      minHeight: 56,
      paddingHorizontal: spacing[4] - 2,
    },
    note: {
      ...t("small"),
      color: colors.textSoft,
      padding: spacing[4],
    },
    row: {
      flexDirection: "row",
      gap: 2,
      marginBottom: 2,
      paddingHorizontal: spacing[4],
    },
    section: { marginTop: spacing[4] },
    sectionTitle: {
      ...t("title"),
      color: colors.text,
      marginBottom: spacing[3],
      paddingHorizontal: spacing[4],
    },
    title: { ...t("bodyStrong"), color: colors.text, flex: 1 },
  });
