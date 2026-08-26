// Real map: iOS MapKit via `expo-maps`; Android MapLibre over OpenFreeMap.
// Split because `expo-maps` on Android is Google Maps. This file owns camera
// and clustering — two SDKs deciding merge separately are two products.
// MapLibre's GeoJSON clusterer is unused (`place-map.ts` tier-floored merge).
// Providers load lazily: evaluating either registers native views.
// Tap does NOT ride SDK marker events: `onAnnotationClick` is iOS 18+ while
// the target is 17.5 (`app.config.ts`); click → pixel → `pinAtPoint`.

import React, { Suspense, useMemo, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";

import {
  fitCamera,
  projectPlaces,
  tierNoun,
} from "@centraid/blueprints/apps/photos/place-map";
import type {
  MapCamera,
  MapPin,
} from "@centraid/blueprints/apps/photos/place-map";

import { Text } from "../../kit/components/NativeText";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { OSM_ATTRIBUTION } from "./places-map-mode";
import type { PlacesMapSurfaceProps } from "./places-map-mode";
import { PIN_MAX } from "./places-model";

export interface PlacesBasemapProps {
  camera: MapCamera;
  pins: readonly MapPin[];
  /** Busiest pin's count — every provider sizes the ramp identically. */
  largest: number;
  width: number;
  height: number;
  activeKey: string | null;
  onRead: (pin: MapPin | null) => void;
  onCamera: (camera: MapCamera) => void;
}

const AppleBasemap = React.lazy(() => import("./places-map-apple"));
const LibreBasemap = React.lazy(() => import("./places-map-libre"));

export default function PlacesRealMap({
  points,
  width,
  height,
  activeKey,
  onRead,
}: PlacesMapSurfaceProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // Null until the member moves: opening viewport is the photographs' own,
  // not the SDK's default centre.
  const [moved, setMoved] = useState<MapCamera | null>(null);
  const fitted = useMemo(
    () => fitCamera(points, { width, height, padding: PIN_MAX / 2 + 6 }),
    [points, width, height]
  );
  const camera = moved ?? fitted;
  const projection = useMemo(
    () =>
      camera === null
        ? null
        : projectPlaces(points, {
            width,
            height,
            camera,
            // Two photographs cannot overlap the way two dots could; pin width
            // is the drawing's threshold. `projectPlaces` floors it with the
            // tier's ground distance once zoomed past what the ledger resolves.
            mergeDistance: PIN_MAX,
          }),
    [points, width, height, camera]
  );

  if (camera === null || projection === null) return <View />;
  const largest = projection.pins.reduce(
    (max, pin) => Math.max(max, pin.count),
    1
  );
  const provider = {
    activeKey,
    camera,
    height,
    largest,
    onCamera: setMoved,
    onRead,
    pins: projection.pins,
    width,
  };

  return (
    <View style={[styles.plate, { height, width }]}>
      {/* Fallback is NOTHING: the plate is the sunken ground; a spinner over
          it is forbidden while the SDK module finishes evaluating. */}
      <Suspense fallback={null}>
        {Platform.OS === "ios" ? (
          <AppleBasemap {...provider} />
        ) : (
          <LibreBasemap {...provider} />
        )}
      </Suspense>
      {/* Same legend as the sketch, off the same ladder. */}
      <View style={styles.legend} pointerEvents="none">
        <Text style={styles.legendText}>{tierNoun(projection.tier)}</Text>
      </View>
      {/* OSM licence requires this wherever OpenFreeMap tiles are drawn.
          MapKit draws its own notice; this would be a second, false claim on iOS. */}
      {Platform.OS === "android" ? (
        <View style={styles.attribution} pointerEvents="none">
          <Text style={styles.attributionText}>{OSM_ATTRIBUTION}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** Tap radius: half a pin. Shared by both providers so hit tests cannot drift. */
export const PIN_TAP_RADIUS = PIN_MAX / 2;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    attribution: {
      backgroundColor: colors.bgElev,
      borderTopEndRadius: radii.sm,
      bottom: 0,
      insetInlineStart: 0,
      paddingHorizontal: spacing[2],
      position: "absolute",
    },
    attributionText: { ...t("mono"), color: colors.textFaint },
    legend: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.sm,
      borderWidth: borders.hairline,
      insetInlineStart: spacing[2],
      paddingHorizontal: spacing[2],
      position: "absolute",
      top: spacing[2],
    },
    legendText: { ...t("mono"), color: colors.textFaint },
    plate: {
      alignItems: "center",
      backgroundColor: colors.bgSunken,
      borderRadius: radii.lg,
      justifyContent: "center",
      overflow: "hidden",
    },
  });
