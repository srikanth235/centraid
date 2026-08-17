// THE PRIVATE SKETCH — the map that asks nobody anything (issue #816).
//
// Every pixel here comes from `place-map.ts`'s arithmetic over coordinates the
// vault already holds: a graticule, a scale bar, north, and the photographs
// themselves as pins. There is no basemap, so opening Places in this mode is
// not a request to anyone. It is the same projection, drawn by the same
// arithmetic, that the web shelf renders in SVG — which is what makes "the two
// Places surfaces agree" a fact rather than a resolution.
//
// It is the other half of the "Use real maps" switch (`places-map-mode.ts`),
// and it is a peer of the basemaps rather than a fallback for them: a member
// who would rather no tile server learned which neighbourhoods they open loses
// the land under the pins and nothing else. The cost is honest and stated in
// `place-map.ts`: a pin on a graticule says exactly what the vault knows.
//
// THE PIN IS THE PHOTOGRAPH, and the grid carries NO numbers. Degrees are
// cartographer's vocabulary — "39.0°N" tells a member nothing about a weekend
// they actually had — so the numbers came off the margins and each pin became
// a picture taken there. The grid stays as unlabelled rhythm; the scale bar and
// the tier legend beside it answer "how far apart" and "what is a pin here" in
// one word each.

import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { G, Line, Text as SvgText } from "react-native-svg";

import {
  projectPlaces,
  tierNoun,
} from "@centraid/blueprints/apps/photos/place-map";

import { radii, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PlacesMapSurfaceProps } from "./places-map-mode";
import { pinSize, PIN_MAX } from "./places-model";
import PlacePin from "./places-pin";

export default function PlacesSketchMap({
  points,
  width,
  height,
  activeKey,
  onRead,
}: PlacesMapSurfaceProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const projection = useMemo(
    () =>
      projectPlaces(points, {
        width,
        height,
        // The padding has to clear half the largest pin or the northernmost
        // picture hangs off the plate. Centres closer than the WIDEST pin
        // cannot both be seen, so that is the merge threshold — two
        // photographs cannot overlap the way two dots could, and a merged pin
        // says how many places it stands for where a half-hidden one does not.
        padding: PIN_MAX / 2 + 6,
        mergeDistance: PIN_MAX,
      }),
    [points, width, height]
  );
  const largest = projection.pins.reduce(
    (max, pin) => Math.max(max, pin.count),
    1
  );

  return (
    <View style={styles.plate}>
      <Svg width={width} height={height}>
        {/* Rhythm, not reference. Labelled, the grid starts asking to be read
            in a vocabulary the reader never signed up for. */}
        <G>
          {projection.parallels.map((line) => (
            <Line
              key={`p${line.degrees}`}
              x1={0}
              x2={width}
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
              y2={height}
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
            {/* What a pin IS at this distance, off the same ladder that
                decided the merge — so the legend cannot describe a grouping
                the drawing did not perform. The web shelf prints the same
                word from the same function. */}
            <SvgText x={8} y={40} fill={colors.textFaint} fontSize={11}>
              {tierNoun(projection.tier)}
            </SvgText>
          </G>
        ) : null}
        <SvgText
          x={width - 8}
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
          handling gives the accessibility tree no control to land on, and a
          plain `Image` in a `Pressable` is far less machinery than an SVG
          image inside a clip path. */}
      {projection.pins.map((pin) => {
        const size = pinSize(pin.count, largest);
        return (
          <PlacePin
            key={`hit-${pin.key}`}
            pin={pin}
            size={size}
            active={pin.key === activeKey}
            onPress={() => onRead(pin)}
            style={{
              left: pin.x - size / 2,
              position: "absolute",
              top: pin.y - size / 2,
            }}
          />
        );
      })}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // The map is a SUNKEN surface — the page, stepped in — so it reads as
    // something looked INTO rather than a card lying on the page. Same rung
    // the web map takes.
    plate: {
      backgroundColor: colors.bgSunken,
      borderRadius: radii.lg,
      overflow: "hidden",
    },
  });
