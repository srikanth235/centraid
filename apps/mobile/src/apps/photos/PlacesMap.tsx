// Places shelf (§14/§18; #816), two modes sharing place-map.ts: the switch swaps
// the GROUND only, never which places plot or what a pin means. Tiles tell the
// provider which areas opened — disclosed permanently under the map (P-egress):
// told, not asked. Pins are photographs; dots labelled in degrees are a chart.

import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";

import { readableName } from "@centraid/blueprints/apps/photos/place-map";
import type { MapPin } from "@centraid/blueprints/apps/photos/place-map";

import AnchoredMenu, { useMenuAnchor } from "../../kit/components/AnchoredMenu";
import type { MenuGroup } from "../../kit/components/AnchoredMenu";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { TEST_IDS } from "../../kit/test-ids";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import {
  mapModeNote,
  MAP_MODE_CHIP,
  REAL_MAP_LABEL,
  SKETCH_MAP_LABEL,
  usePlacesMapMode,
} from "./places-map-mode";
import { placePoints } from "./places-model";
import PlacesRealMap from "./PlacesRealMap";
import PlacesSketchMap from "./PlacesSketchMap";
import { usePhotoTimeline } from "./timeline-source";

export default function PlacesMap({
  navigation,
}: PhotosScreenProps<"PlacesMap">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { width } = useWindowDimensions();
  const [reading, setReading] = useState<MapPin | null>(null);
  const [mode, setMode] = usePlacesMapMode();
  const [modeOpen, setModeOpen] = useState(false);
  // Destructured: anchorRef feeds a ref prop; reachable-through-ref reads as ref access during render.
  const {
    anchor: modeAnchor,
    anchorRef: modeAnchorRef,
    measureAnchor,
  } = useMenuAnchor();
  const places = useReplicaQuery(
    "photos",
    useMemo(() => ({ acceptTruncation: true, entity: "core.place" }), [])
  );
  const { assets } = usePhotoTimeline();

  // Id→row lookup stays inside the memo: hoisted out, it rebuilt every render
  // and was useless as a dependency.
  const points = useMemo(
    () => placePoints(assets, places.rows),
    [assets, places.rows]
  );

  const mapWidth = Math.max(1, width - spacing[4] * 2);
  const mapHeight = Math.round(mapWidth * 0.9);
  const surface = {
    activeKey: reading?.key ?? null,
    height: mapHeight,
    onRead: setReading,
    points,
    width: mapWidth,
  };
  const modeGroups: MenuGroup[] = [
    {
      key: "map-mode",
      rows: [
        {
          checked: mode === "real",
          key: "real",
          label: REAL_MAP_LABEL,
          onSelect: () => setMode("real"),
        },
        {
          checked: mode === "sketch",
          key: "sketch",
          label: SKETCH_MAP_LABEL,
          onSelect: () => setMode("sketch"),
        },
      ],
    },
  ];

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
        {/* Geotagged plotted, of library total. */}
        <Text style={styles.count}>
          {points.reduce((sum, point) => sum + point.count, 0)} of{" "}
          {assets.length}
        </Text>
        {/* Acts on what is on screen. */}
        <Pressable
          accessibilityLabel="Map mode"
          accessibilityRole="button"
          onPress={() => {
            measureAnchor();
            setModeOpen(true);
          }}
          ref={modeAnchorRef}
          style={styles.modeChip}
        >
          <Text style={styles.modeChipText}>{MAP_MODE_CHIP}</Text>
        </Pressable>
      </View>
      <ReplicaStatusBar />
      <View style={styles.stage} testID={TEST_IDS.places.map}>
        {points.length ? (
          mode === "real" ? (
            <PlacesRealMap {...surface} />
          ) : (
            <PlacesSketchMap {...surface} />
          )
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              No places yet — a photograph lands here once it carries where it
              was taken.
            </Text>
          </View>
        )}
        {/* ONE node, two states: the resting privacy sentence and a pressed
            pin's readout are the same slot, so a flow reads the slot by id and
            asserts WHICH sentence is in it — the sentence is the claim. */}
        {reading ? (
          <Text style={styles.readout} testID={TEST_IDS.places.readout}>
            {readableName(reading.name) ?? "An unnamed place"} · {reading.count}
          </Text>
        ) : (
          <Text style={styles.readout} testID={TEST_IDS.places.readout}>
            Plotted from your own photographs.
          </Text>
        )}
        {/* `net` marks what leaves the device. */}
        <Text
          style={[
            styles.note,
            { color: mode === "real" ? colors.net : colors.textFaint },
          ]}
        >
          {mapModeNote(mode)}
        </Text>
      </View>
      <AnchoredMenu
        visible={modeOpen}
        anchor={modeAnchor}
        groups={modeGroups}
        onClose={() => setModeOpen(false)}
      />
    </TopSafeArea>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    count: { ...t("mono"), color: colors.textSoft, marginEnd: spacing[2] },
    empty: {
      alignItems: "center",
      paddingVertical: spacing[5],
    },
    emptyText: {
      ...t("small"),
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
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
    modeChip: {
      borderColor: colors.line,
      borderRadius: radii.pill,
      borderWidth: borders.hairline,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[1],
    },
    modeChipText: { ...t("mono"), color: colors.textSoft },
    note: { ...t("small"), marginTop: spacing[1] },
    readout: { ...t("small"), color: colors.textFaint, marginTop: spacing[2] },
    safe: { flex: 1 },
    stage: { flex: 1, padding: spacing[4] },
    title: { ...t("title"), color: colors.text, flex: 1 },
  });
