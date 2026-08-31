// THE PIN, once for all three grounds (#816): sketch graticule, MapKit,
// MapLibre. A real `Pressable` with an accessible name — never a bare shape;
// native marker press events are unreliable at this iOS floor. Positioned by
// its CENTRE by every caller.

import React, { useMemo } from "react";
import { Image, Pressable, StyleSheet } from "react-native";

import type { MapPin } from "@centraid/blueprints/apps/photos/place-map";

import { Text } from "../../kit/components/NativeText";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { pinLabel } from "./places-model";

export interface PlacePinProps {
  pin: MapPin;
  /** Drawn edge; area tracks the count. */
  size: number;
  active: boolean;
  onPress: () => void;
  style?: object;
  /** A positional handle from `kit/test-ids`, supplied by the map that plots it. */
  testID?: string;
}

export default function PlacePin({
  pin,
  size,
  active,
  onPress,
  style,
  testID,
}: PlacePinProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityLabel={pinLabel(pin)}
      accessibilityRole="button"
      onPress={onPress}
      testID={testID}
      style={[
        styles.pin,
        { height: size, width: size },
        active ? styles.pinActive : null,
        style ?? null,
      ]}
    >
      {pin.thumb ? (
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri: pin.thumb }}
          style={styles.shot}
        />
      ) : null}
      {/* Reads in mono like every other count in this app. */}
      <Text style={styles.pinCount}>{pin.count}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    pin: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      overflow: "hidden",
    },
    // Ring, not scale: centre-positioned pins would need re-layout to grow.
    pinActive: { borderColor: colors.accent, borderWidth: 2 },
    // Solid stage ink; RN cannot `color-mix` and slicing tokens invents colours.
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
    shot: { height: "100%", width: "100%" },
  });
