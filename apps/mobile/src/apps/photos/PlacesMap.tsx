// Places on the phone, in two modes (Photos v4 handoff §14, §18; #816).
//
// A shelf reached from the Places grid's Map chip, not a destination of its
// own. The map is the content; everything this screen adds is a header that
// names the shelf and states its size exactly — a count is a numeral, so it
// reads in mono.
//
// The empty state is the shelf's own: a place is not something a member forgot
// to do, it is something a photograph either carries or does not.
//
// TWO MAPS, ONE PROJECTION. The default is the phone's real basemap
// (`PlacesRealMap` — MapKit on iOS, MapLibre over OpenFreeMap on Android, both
// keyless), and the switch beside the title swaps it for the private sketch
// (`PlacesSketchMap`), the graticule the web shelf draws from coordinates the
// vault already holds. Both are handed the same places and both run
// `place-map.ts`, so what the switch changes is the GROUND, never which places
// are one pin or what a pin means at a given scale.
//
// THE DISCLOSURE IS A LINE ON THIS SCREEN, not a gate in front of it
// (docs/decisions.md, P-egress). A basemap is fetched by tile and a tile is an
// area, so the provider learns which neighbourhoods were opened; it is handed
// nothing else, because the pins are drawn over it by this app. That is stated
// under the map in whichever mode is on, permanently, beside the control that
// answers it — a member is told, not asked.
//
// AND THE PIN IS THE PHOTOGRAPH, on both grounds. The first cut drew dots on a
// graticule labelled in degrees, which is a chart, not a map: nobody remembers
// a weekend as 39.0°N. The numbers came off the margins and each pin became a
// picture taken there. The web shelf made the same change at the same time,
// off the same projection.

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
  // Destructured, never held as one object: `anchorRef` goes to a `ref` prop,
  // and anything reachable through a ref-carrying value reads as a ref access
  // during render. Same shape `PhotosHome` uses for the Library chip.
  const {
    anchor: modeAnchor,
    anchorRef: modeAnchorRef,
    measureAnchor,
  } = useMenuAnchor();
  const places = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.place" }), [])
  );
  const { assets } = usePhotoTimeline();

  // One PlacePoint per place, counted over the loaded window — the arithmetic
  // lives in `places-model.ts` beside the shelf's own, where the two groupings
  // can be read (and falsified) side by side. The id→row lookup is built
  // inside it rather than in a memo of its own: hoisting it out rebuilt it
  // every render, which made it useless as a dependency and forced a lint
  // suppression to paper over that; the rows are what actually decide whether
  // this recomputes.
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
        {/* Stated exactly, in mono: how many geotagged photographs are drawn,
            and out of how many the library holds. Never a badge. */}
        <Text style={styles.count}>
          {points.reduce((sum, point) => sum + point.count, 0)} of{" "}
          {assets.length}
        </Text>
        {/* The mode lives on the screen it governs, in the app's own settings
            idiom — an anchored menu of checked rows, the same one the Library
            chip opens for the tile-size rung. A control that cannot act on
            what is on screen is the failure `photos-library-menu.ts` names;
            this one acts on nothing else. */}
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
      <View style={styles.stage}>
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
        {reading ? (
          <Text style={styles.readout}>
            {readableName(reading.name) ?? "An unnamed place"} · {reading.count}
          </Text>
        ) : (
          <Text style={styles.readout}>Plotted from your own photographs.</Text>
        )}
        {/* `net` is the role for anything that leaves the device, so the ink
            itself carries the difference between the two modes: the sketch's
            line is ordinary faint chrome because nothing leaves. */}
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
