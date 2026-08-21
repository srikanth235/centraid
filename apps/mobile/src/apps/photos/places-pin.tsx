// THE PIN, once, for all three drawings (issue #816).
//
// Places renders the same pin over three different grounds — the private
// sketch's graticule, MapKit on iOS, and MapLibre's vector tiles on Android —
// and they have to be the same object. A pin that looked like a photograph on
// the sketch and like a coloured bubble on a basemap would make the mode
// switch a change of product rather than a change of ground.
//
// It is a real `Pressable` with an accessible name, never a shape with an
// `onPress`: a screen reader has to have something to land on, and the map is
// the one surface where the alternative (an SVG shape, or a native marker) is
// the tempting shortcut. On the basemaps the same control is what a native
// marker's press events would otherwise have to provide — see `PlacesRealMap`
// for why those events cannot be relied on at the app's iOS floor.
//
// Positioned by its CENTRE by every caller. A pin hanging down-right of its
// point would put every photograph slightly south-east of where it was taken.

import React, { useMemo } from "react";
import { Image, Pressable, StyleSheet } from "react-native";

import type { MapPin } from "@centraid/blueprints/apps/photos/place-map";

import { Text } from "../../kit/components/NativeText";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { pinLabel } from "./places-model";

export interface PlacePinProps {
  pin: MapPin;
  /** The drawn edge of the pin, from `pinSize` — area tracks the count. */
  size: number;
  /** The place being read, drawn as the one ringed pin. */
  active: boolean;
  onPress: () => void;
  /** Where the caller puts it: absolute on the sketch, anchored on a basemap. */
  style?: object;
}

export default function PlacePin({
  pin,
  size,
  active,
  onPress,
  style,
}: PlacePinProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityLabel={pinLabel(pin)}
      accessibilityRole="button"
      onPress={onPress}
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
      {/* A count is a numeral, so it reads in mono like every other count in
          this app. */}
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
    // The place being read: an ink-edged sheet standing off the ground. No
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
    shot: { height: "100%", width: "100%" },
  });
