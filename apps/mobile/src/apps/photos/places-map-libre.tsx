// The Android half of the real map (#816); `expo-maps` would pull Google Maps
// and Play Services here. Import only via `React.lazy` (`PlacesRealMap.tsx`) —
// this registers MapLibre's native views.
//
// NEVER USE MAPLIBRE'S OWN CLUSTERER: `GeoJSONSource` groups differently from
// `place-map.ts`, so Android would disagree with iOS. Pins arrive merged.

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

/** The map's only egress; keyless and accountless, so no token host. */
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
      // `PlacesRealMap` draws the required OpenStreetMap credit permanently.
      attribution={false}
      logo={false}
      touchPitch={false}
      touchRotate={false}
      onPress={() => onRead(null)}
      onRegionDidChange={(event) => {
        const [, south, , north] = event.nativeEvent.bounds;
        const [lng, lat] = event.nativeEvent.center;
        onCamera({
          lat,
          lng,
          // Latitude degrees are uniform, so this matches iOS.
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
        // Anchor to the ground, not the box, so pins hold still while panning.
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
  // Off-centre shifts every photograph off its point.
  anchor: { alignItems: "center", justifyContent: "center" },
});
