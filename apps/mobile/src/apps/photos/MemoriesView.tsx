import React, { useMemo } from "react";
import {
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Circle, Polyline } from "react-native-svg";

import { projectPlaces } from "@centraid/blueprints/apps/photos/place-map";
import type { TripRoutePoint } from "@centraid/blueprints/apps/photos/trips";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import Tappable from "../../kit/components/Tappable";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import { justify } from "./justify";
import {
  buildMemoriesModel,
  hasNoMemories,
  memoryPlacesById,
  tripDateLabel,
  yearsAgo,
} from "./memories-model";
import type {
  MemoryYearGroup,
  RawMemoryMemberRow,
  RawMemoryRow,
  RawPlaceRow,
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

const RAIL_PREVIEW_LIMIT = 30;

const NOTHING_YET =
  "Your own photographs, noticed — a year behind a day, a trip, a burst.";

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

const SKETCH_WIDTH = 96;
const SKETCH_HEIGHT = 56;

function RouteSketch({
  route,
  colors,
  styles,
}: {
  route: readonly TripRoutePoint[];
  colors: ThemeColors;
  styles: Styles;
}): React.JSX.Element | null {
  const { pins } = projectPlaces(route, {
    width: SKETCH_WIDTH,
    height: SKETCH_HEIGHT,
    padding: 7,
    mergeDistance: 0,
  });
  const stops = route.flatMap((point) => {
    const pin = pins.find((candidate) => candidate.key === point.key);
    return pin ? [pin] : [];
  });
  if (stops.length === 0) return null;
  return (
    <View style={styles.sketch}>
      <Svg width={SKETCH_WIDTH} height={SKETCH_HEIGHT}>
        {stops.length > 1 ? (
          <Polyline
            points={stops.map((pin) => `${pin.x},${pin.y}`).join(" ")}
            fill="none"
            stroke={colors.textFaint}
            strokeWidth={1}
          />
        ) : null}
        {stops.map((pin) => (
          <Circle
            key={pin.key}
            cx={pin.x}
            cy={pin.y}
            r={2.5}
            fill={colors.textSoft}
          />
        ))}
      </Svg>
    </View>
  );
}

function TripBlock({
  trip,
  colors,
  onOpen,
  styles,
}: {
  trip: TripMemory;
  colors: ThemeColors;
  onOpen: (asset: PhotoAsset) => void;
  styles: Styles;
}): React.JSX.Element {
  const dateLabel = tripDateLabel(trip);
  return (
    <View style={styles.block}>
      <View style={styles.tripHead}>
        <View style={styles.tripWords}>
          {/* Ladder sentence from trips.ts, never a coordinate. */}
          <Text style={styles.blockTitle} numberOfLines={1}>
            {trip.title}
          </Text>
          {dateLabel ? <Text style={styles.blockMeta}>{dateLabel}</Text> : null}
        </View>
        {trip.route.length > 0 ? (
          <RouteSketch route={trip.route} colors={colors} styles={styles} />
        ) : null}
      </View>
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

  const placeFacts = useMemo(
    () => memoryPlacesById(places.rows as readonly RawPlaceRow[]),
    [places.rows]
  );

  const now = useMemo(() => new Date(), []);

  const model = useMemo(
    () =>
      buildMemoriesModel(
        memoryRows.rows as readonly RawMemoryRow[],
        memberRows.rows as readonly RawMemoryMemberRow[],
        assets,
        placeFacts,
        now
      ),
    [memoryRows.rows, memberRows.rows, assets, placeFacts, now]
  );

  const open = (asset: PhotoAsset): void => {
    navigation.navigate("PhotoLightbox", { assetId: asset.id });
  };

  const empty = hasNoMemories(model);

  return (
    <PhotosScreen current="more">
      <View style={styles.header}>
        <Tappable
          accessibilityLabel="Back to Photos"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
        >
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Tappable>
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
                    colors={colors}
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
    sketch: {
      backgroundColor: colors.bgSunken,
      borderRadius: radii.md,
      marginEnd: spacing[4],
      overflow: "hidden",
    },
    sectionTitle: {
      ...t("title"),
      color: colors.text,
      marginBottom: spacing[3],
      paddingHorizontal: spacing[4],
    },
    title: { ...t("bodyStrong"), color: colors.text, flex: 1 },
    tripHead: { alignItems: "center", flexDirection: "row" },
    tripWords: { flex: 1 },
  });
