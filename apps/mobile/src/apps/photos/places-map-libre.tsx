// MAPLIBRE OVER OPENFREEMAP — the Android half of the real map (#816).
//
// Android only, and for a reason worth stating: `expo-maps` — which draws the
// iOS half through MapKit — pulls Google Maps on Android, and with it an API
// key and Play Services. MapLibre is the renderer with no vendor attached, and
// OpenFreeMap serves the vector tiles with no key, no registration and no
// account. The config plugin keeps its `locationEngine: "default"`, so no Play
// Services dependency arrives through the back door either.
//
// Reached only through `React.lazy` (`PlacesRealMap.tsx`): importing this
// module registers MapLibre's native views, and a member on the private
// sketch, on iOS, or inside a test runner should never pay for that.
//
// MAPLIBRE'S OWN CLUSTERER IS DELIBERATELY UNUSED. `GeoJSONSource` will
// cluster for us, and it is not the same function as `place-map.ts`'s merge —
// so a member on Android would see places grouped one way and the same
// library on iOS or the web grouped another. Pins arrive already merged; this
// file's whole job is to put them where the ground is.
//
// The pins are `Marker`s carrying our own React view, so each one is a real
// `Pressable` in the accessibility tree — the same control the sketch draws.
// The map's own press clears the readout, which is what tapping the ground
// means.

import { Camera, Map, Marker } from "@maplibre/maplibre-react-native";
import React from "react";
import { StyleSheet, View } from "react-native";

import {
  coordAt,
  kmPerPxForSpan,
  tileZoomFor,
} from "@centraid/blueprints/apps/photos/place-map";

import { pinSize } from "./places-model";
import PlacePin from "./places-pin";
import type { PlacesBasemapProps } from "./PlacesRealMap";

/**
 * OpenFreeMap's actively maintained style.
 *
 * The one URL this product asks anybody for, and the only egress the real map
 * has: a viewport's worth of tiles. It carries no key, no account and no
 * identifier, and OpenFreeMap keeps no user database — which is why it is this
 * one rather than a commercial host with a token. The full planet is
 * downloadable, so the same style can be re-pointed at a self-hosted origin
 * later without touching anything else in this file.
 */
const OPEN_FREE_MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

export default function PlacesLibreMap({
  camera,
  pins,
  largest,
  width,
  height,
  activeKey,
  onRead,
  onCamera,
}: PlacesBasemapProps): React.JSX.Element {
  return (
    <Map
      style={{ height, width }}
      mapStyle={OPEN_FREE_MAP_STYLE}
      // The ornaments are drawn by this app instead (`PlacesRealMap`): the
      // required OpenStreetMap credit is a permanent line on the map rather
      // than a button a member has to find and press.
      attribution={false}
      logo={false}
      // A photograph map has no use for pitch or rotation, and both make the
      // pins' anchors read as wrong when the ground tilts under them.
      touchPitch={false}
      touchRotate={false}
      onPress={() => onRead(null)}
      onRegionDidChange={(event) => {
        const [, south, , north] = event.nativeEvent.bounds;
        const [lng, lat] = event.nativeEvent.center;
        onCamera({
          lat,
          lng,
          // Latitude is the axis whose degrees are the same length
          // everywhere, so this is the same number MapKit's `latitudeDelta`
          // yields on iOS — one camera type, one merge, two platforms.
          kmPerPx: kmPerPxForSpan(north - south, height),
        });
      }}
    >
      <Camera
        initialViewState={{
          center: [camera.lng, camera.lat],
          zoom: tileZoomFor(camera),
        }}
      />
      {pins.map((pin) => {
        // Anchored to the GROUND rather than to the box, so a marker holds
        // still under a finger while the map moves. `coordAt` runs the
        // projection backwards to ask where the pin's pixel actually is.
        const where = coordAt(camera, { height, width }, pin.x, pin.y);
        return (
          <Marker key={pin.key} id={pin.key} lngLat={[where.lng, where.lat]}>
            <View style={styles.anchor}>
              <PlacePin
                pin={pin}
                size={pinSize(pin.count, largest)}
                active={pin.key === activeKey}
                onPress={() => onRead(pin)}
              />
            </View>
          </Marker>
        );
      })}
    </Map>
  );
}

const styles = StyleSheet.create({
  // `Marker` takes exactly one child and anchors it by its centre, which is
  // the same rule the sketch positions by: a pin hanging down-right of its
  // point would put every photograph slightly south-east of where it was
  // taken.
  anchor: { alignItems: "center", justifyContent: "center" },
});
