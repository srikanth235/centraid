import { Camera, Map, Marker } from "@maplibre/maplibre-react-native";
import React from "react";
import { StyleSheet, View } from "react-native";

import {
  coordAt,
  kmPerPxForSpan,
  tileZoomFor,
} from "@centraid/blueprints/apps/photos/place-map";

import { TEST_ID_PREFIXES } from "../../kit/test-ids";
import { pinSize } from "./places-model";
import PlacePin from "./places-pin";
import type { PlacesBasemapProps } from "./PlacesRealMap";

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
      {pins.map((pin, index) => {
        const where = coordAt(camera, { height, width }, pin.x, pin.y);
        return (
          <Marker key={pin.key} id={pin.key} lngLat={[where.lng, where.lat]}>
            <View style={styles.anchor}>
              <PlacePin
                testID={`${TEST_ID_PREFIXES.placesPin}${index}`}
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
  anchor: { alignItems: "center", justifyContent: "center" },
});
