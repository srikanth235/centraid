// THE REAL MAP — land under the photographs, from the phone's own SDK.
//
// Two providers, one product. iOS draws MapKit through `expo-maps`; Android
// draws MapLibre over OpenFreeMap's vector tiles. They are split because
// `expo-maps` on Android is Google Maps — an API key, Play Services, and a
// vendor this product has no reason to introduce — and MapLibre needs a style
// URL that MapKit has no concept of. Neither needs a key, and neither is asked
// for anything but a viewport.
//
// WHAT THIS FILE OWNS, AND WHY IT IS NOT IN EITHER PROVIDER. The camera and
// the clustering. A provider is handed pins and told where to put them; it
// never decides which places are one pin, because the moment two SDKs decide
// that separately the two platforms are two products. MapLibre ships a
// perfectly good GeoJSON clusterer and it is deliberately not used: it is not
// the same function as `place-map.ts`'s tier-floored pixel merge, which is
// also what the private sketch and the web shelf run.
//
// THE PROVIDERS ARE LOADED LAZILY, and that is load-bearing rather than a
// startup nicety. Evaluating either module registers native view components;
// a member on the private sketch, on the other platform, or inside a test
// runner must never pay for a map SDK they are not looking at. Same reason
// `lazy-screens.tsx` exists one directory up.
//
// The tap does NOT ride the SDK's marker events. `expo-maps` gates
// `onAnnotationClick` at iOS 18 while this app's deployment target is 17.5
// (`app.config.ts`), so a pin press would silently do nothing on iOS 17. The
// map's own click reports a coordinate, the projection turns that into a
// pixel, and `pinAtPoint` says which pin it was — the same arithmetic the
// sketch's `Pressable`s stand on.

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

/** What a provider is handed. Everything decided here; nothing to decide. */
export interface PlacesBasemapProps {
  camera: MapCamera;
  /**
   * The viewport the PHOTOGRAPHS chose — what a provider COMMANDS its SDK to,
   * as opposed to `camera`, which is wherever the member has since moved it.
   *
   * The two are separate because an SDK's camera must not be a controlled
   * prop. A provider that echoes the camera the SDK just reported back at it
   * as a command closes a feedback loop, and the loop only holds still if the
   * conversion in each direction is the exact inverse of the other — which is
   * a property no SDK owes us. Commanding the fit instead means the member's
   * own panning is never fought, and this changes only when the photographs
   * being drawn do.
   */
  opening: MapCamera;
  pins: readonly MapPin[];
  /** The busiest pin's count, so every provider sizes the ramp identically. */
  largest: number;
  width: number;
  height: number;
  activeKey: string | null;
  onRead: (pin: MapPin | null) => void;
  /** The member moved the map. A new camera means a new clustering. */
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
  // Null until the member moves the map: the opening viewport is the one the
  // photographs choose for themselves, so Places opens on the member's own
  // roll rather than on whatever the SDK's default centre is.
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
            // Two photographs cannot overlap the way two dots could, so a pin's
            // full width is the drawing's threshold — and `projectPlaces`
            // floors it with the tier's own ground distance once a member has
            // zoomed past what the place ledger can resolve.
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
    opening: fitted ?? camera,
    pins: projection.pins,
    width,
  };

  return (
    <View style={[styles.plate, { height, width }]}>
      {/* The fallback is NOTHING, deliberately: the plate under this is the
          sunken ground the map lands on, and a spinner over it would be the
          one thing the rulebook forbids outright while the SDK's own module
          finishes evaluating — which is a frame or two, not a wait. */}
      <Suspense fallback={null}>
        {Platform.OS === "ios" ? (
          <AppleBasemap {...provider} />
        ) : (
          <LibreBasemap {...provider} />
        )}
      </Suspense>
      {/* The same legend the sketch prints, off the same ladder — so switching
          modes changes the ground and not what a pin means. */}
      <View style={styles.legend} pointerEvents="none">
        <Text style={styles.legendText}>{tierNoun(projection.tier)}</Text>
      </View>
      {/* OSM's licence requires this wherever OpenFreeMap's tiles are drawn.
          MapKit draws its own legal notice, so this would be a second, false
          claim on iOS. */}
      {Platform.OS === "android" ? (
        <View style={styles.attribution} pointerEvents="none">
          <Text style={styles.attributionText}>{OSM_ATTRIBUTION}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** The tap radius: half a pin, so a finger anywhere on the photograph opens
 *  it and the ground beside it stays the ground. Shared by both providers
 *  through this module so a hit test cannot drift per platform. */
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
    // The same sunken plate the sketch stands on, so the mode switch changes
    // what is inside the frame and not the frame.
    plate: {
      alignItems: "center",
      backgroundColor: colors.bgSunken,
      borderRadius: radii.lg,
      justifyContent: "center",
      overflow: "hidden",
    },
  });
