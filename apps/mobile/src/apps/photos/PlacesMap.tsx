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
import { Text } from "../../kit/components/NativeText";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { TEST_IDS } from "../../kit/test-ids";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import { usePhotoEntity } from "./photo-entity-reads";
import PhotosScreen from "./PhotosScreen";
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
  const places = usePhotoEntity("places");
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

  // The room draws the title, the back key — named for the Places shelf this
  // map is opened from (`photosParentPlace`) — and the band (#1015, R-NY-7).
  // The count and the mode chip pick what the stage shows, so they ride the
  // room's toolbar, above the body and outside it.
  return (
    <PhotosScreen
      onBack={() => navigation.goBack()}
      route="placesMap"
      title="Map"
      toolbar={
        <View style={styles.toolbar}>
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
      }
    >
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
    </PhotosScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    count: {
      ...t("mono"),
      color: colors.textSoft,
      flex: 1,
      marginEnd: spacing[2],
    },
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
    stage: { flex: 1, padding: spacing[4] },
    // Level with the stage's own inset, so the count sits over the map edge.
    toolbar: {
      alignItems: "center",
      flexDirection: "row",
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[1],
    },
  });
