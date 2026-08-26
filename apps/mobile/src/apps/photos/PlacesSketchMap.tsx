// THE PRIVATE SKETCH (#816): place-map.ts arithmetic over vault coordinates — graticule, scale bar,
// north, photos as pins. No basemap: opening Places requests nothing of anyone.

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
        // Padding clears half the largest pin; merge = widest pin.
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
        {/* Rhythm, not reference. */}
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
            {/* Matches the web shelf. */}
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
            {/* Same ladder/word as the merge. */}
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
      {/* Real Pressables above the svg: RNSVG gives the a11y tree no control to land on. */}
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
    // Sunken surface — read INTO, not a card lying on the page.
    plate: {
      backgroundColor: colors.bgSunken,
      borderRadius: radii.lg,
      overflow: "hidden",
    },
  });
