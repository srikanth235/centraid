import React, { useMemo, useState } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { G, Line, Text as SvgText } from "react-native-svg";

// Places on the phone (Photos v4 handoff §14, §18).
//
// A shelf reached from the More sheet, not a destination of its own. The map is
// the content; everything this screen adds is a header that names the shelf and
// states its size exactly — a count is a numeral, so it reads in mono.
//
// The empty state is the shelf's own: a place is not something a member forgot
// to do, it is something a photograph either carries or does not.
//
// NO BASEMAP, AND THAT IS THE CHANGE. This screen used to draw `MapView` from
// `react-native-maps`, which renders the OS map — so opening Places asked
// Apple's (or Google's) tile service for the neighbourhoods the member had
// photographed. It was the only place in the product where looking at your own
// library told a third party anything, in an app whose gateway refuses a
// non-loopback enrichment URL specifically so bytes cannot leave the host.
//
// What replaced it is `place-map.ts` — the same projection the web shelf runs, // drawn here with `react-native-svg`. Two consequences worth stating: the two
// Places surfaces now agree because they execute the same arithmetic rather
// than because someone kept them in step, and the phone stopped emitting. The
// cost is honest — there is no land under the pins. See place-map.ts for why
// that is the truthful trade rather than a stopgap.
//
// AND THE PIN IS THE PHOTOGRAPH. The first cut drew dots on a graticule
// labelled in degrees, which is a chart, not a map: nobody remembers a weekend
// as 39.0°N. The numbers came off the margins and each pin became a picture
// taken there, so the map is read by recognition. The web shelf made the same
// change at the same time, off the same projection.
import {
  projectPlaces,
  readableName,
} from "@centraid/blueprints/apps/photos/place-map";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { borders, spacing, t, useTheme, radii } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import { pinLabel, pinSize, placePoints, PIN_MAX } from "./places-model";
import { usePhotoTimeline } from "./timeline-source";

export default function PlacesMap({
  navigation,
}: PhotosScreenProps<"PlacesMap">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { width } = useWindowDimensions();
  const [reading, setReading] = useState<string | null>(null);
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
  const projection = useMemo(
    () =>
      projectPlaces(points, {
        width: mapWidth,
        height: mapHeight,
        // The padding has to clear half the largest pin or the northernmost
        // picture hangs off the plate. Centres closer than the WIDEST pin
        // cannot both be seen, so that is the merge threshold — two
        // photographs cannot overlap the way two dots could, and a merged pin
        // says how many places it stands for where a half-hidden one does not.
        padding: PIN_MAX / 2 + 6,
        mergeDistance: PIN_MAX,
      }),
    [points, mapWidth, mapHeight]
  );
  const largest = projection.pins.reduce(
    (max, pin) => Math.max(max, pin.count),
    1
  );
  const readingPin = projection.pins.find((pin) => pin.key === reading) ?? null;

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
      </View>
      <ReplicaStatusBar />
      <View style={styles.stage}>
        {points.length ? (
          <View style={styles.plate}>
            <Svg width={mapWidth} height={mapHeight}>
              {/* The grid carries NO numbers — it is rhythm, something to
                  measure the spread against. Labelled, it starts asking to be
                  read in a vocabulary the reader never signed up for; the
                  scale bar answers "how far apart" in one phrase instead. */}
              <G>
                {projection.parallels.map((line) => (
                  <Line
                    key={`p${line.degrees}`}
                    x1={0}
                    x2={mapWidth}
                    y1={line.at}
                    y2={line.at}
                    stroke={colors.line}
                    strokeWidth={1}
                  />
                ))}
                {projection.meridians.map((line) => (
                  <Line
                    key={`m${line.degrees}`}
                    x1={line.at}
                    x2={line.at}
                    y1={0}
                    y2={mapHeight}
                    stroke={colors.line}
                    strokeWidth={1}
                  />
                ))}
              </G>
              {projection.scale.px > 0 ? (
                <G>
                  {/* Top-left, matching the web shelf. */}
                  <Line
                    x1={8}
                    x2={8 + projection.scale.px}
                    y1={26}
                    y2={26}
                    stroke={colors.textFaint}
                    strokeWidth={1}
                  />
                  <SvgText x={8} y={20} fill={colors.textFaint} fontSize={11}>
                    {projection.scale.km >= 1
                      ? `${projection.scale.km} km`
                      : `${Math.round(projection.scale.km * 1000)} m`}
                  </SvgText>
                </G>
              ) : null}
              <SvgText
                x={mapWidth - 8}
                y={16}
                textAnchor="end"
                fill={colors.textFaint}
                fontSize={11}
              >
                N ↑
              </SvgText>
            </Svg>
            {/* The pins live in real Pressables ABOVE the svg rather than in
                `onPress` on an SVG shape: they are photographs, RNSVG's press
                handling gives the accessibility tree no control to land on,
                and a plain `Image` in a `Pressable` is far less machinery than
                an SVG image inside a clip path. Positioned by CENTRE — a pin
                hanging down-right of its point would put every photograph
                slightly south-east of where it was taken. */}
            {projection.pins.map((pin) => {
              const size = pinSize(pin.count, largest);
              const active = pin.key === reading;
              return (
                <Pressable
                  key={`hit-${pin.key}`}
                  accessibilityLabel={pinLabel(pin)}
                  accessibilityRole="button"
                  onPress={() => setReading(pin.key)}
                  style={[
                    styles.pin,
                    {
                      height: size,
                      left: pin.x - size / 2,
                      top: pin.y - size / 2,
                      width: size,
                    },
                    active ? styles.pinActive : null,
                  ]}
                >
                  {pin.thumb ? (
                    <Image
                      accessibilityIgnoresInvertColors
                      source={{ uri: pin.thumb }}
                      style={styles.shot}
                    />
                  ) : null}
                  {/* A count is a numeral, so it reads in mono like every
                      other count in this app. */}
                  <Text style={styles.pinCount}>{pin.count}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              No places yet — a photograph lands here once it carries where it
              was taken.
            </Text>
          </View>
        )}
        {readingPin ? (
          <Text style={styles.readout}>
            {readableName(readingPin.name) ?? "An unnamed place"} ·{" "}
            {readingPin.count}
          </Text>
        ) : (
          <Text style={styles.readout}>
            Plotted from your own photographs. Nothing is fetched.
          </Text>
        )}
      </View>
    </TopSafeArea>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    count: { ...t("mono"), color: colors.textSoft },
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
    pin: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      overflow: "hidden",
      position: "absolute",
    },
    // The place being read: an ink-edged sheet standing off the plate. No
    // scale transform — a pin positioned by its centre would have to be
    // re-laid-out to grow, and a ring says "this one" just as clearly.
    pinActive: { borderColor: colors.accent, borderWidth: 2 },
    // Ink over media takes the stage rung, the one ink that does not flip
    // with the theme because the surface under it does not either. Solid
    // rather than the web's translucent veil: RN cannot `color-mix`, and
    // deriving an alpha by slicing the token string would be inventing a
    // colour the design package never published.
    pinCount: {
      ...t("mono"),
      backgroundColor: colors.stage,
      borderTopLeftRadius: radii.md,
      bottom: 0,
      color: colors.onStage,
      overflow: "hidden",
      paddingHorizontal: 4,
      position: "absolute",
      right: 0,
    },
    // The map is a SUNKEN surface — the page, stepped in — so it reads as
    // something looked INTO rather than a card lying on the page. Same rung
    // the web map takes.
    plate: {
      backgroundColor: colors.bgSunken,
      borderRadius: radii.lg,
      overflow: "hidden",
    },
    readout: { ...t("small"), color: colors.textFaint, marginTop: spacing[2] },
    safe: { flex: 1 },
    shot: { height: "100%", width: "100%" },
    stage: { flex: 1, padding: spacing[4] },
    title: { ...t("title"), color: colors.text, flex: 1 },
  });
