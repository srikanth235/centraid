// MapKit via `expo-maps` — iOS half of the real map (#816); Android is
// MapLibre (`places-map-libre.tsx`). Lazy-import only (`PlacesRealMap.tsx`):
// importing registers a native view. Never wire `onAnnotationClick` (`ios
// 18.0+`, target 17.5 in `app.config.ts`) — pins would silently do nothing.
// No clustering in `expo-maps`; `pins` arrive pre-merged. These are
// `annotations`, not `markers`: only an annotation takes an `icon`.

import { Image as ExpoImage } from "expo-image";
import type { ImageRef } from "expo-image";
import { AppleMaps } from "expo-maps";
import React, { useEffect, useState } from "react";

import {
  coordAt,
  kmPerPxForSpan,
  pinAtPoint,
  projectAt,
  tileZoomFor,
} from "@centraid/blueprints/apps/photos/place-map";
import type { MapPin } from "@centraid/blueprints/apps/photos/place-map";

import { PIN_TAP_RADIUS } from "./PlacesRealMap";
import type { PlacesBasemapProps } from "./PlacesRealMap";

// Keyed by URI, not pin key: a merge changes the key, not the picture.
const icons = new Map<string, ImageRef>();

function usePinIcons(pins: readonly MapPin[]): number {
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    let live = true;
    const missing = pins
      .map((pin) => pin.thumb)
      .filter((uri): uri is string => Boolean(uri) && !icons.has(uri!));
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (uri) => {
        try {
          icons.set(uri, await ExpoImage.loadAsync(uri));
        } catch {
          // A pin that will not decode still draws, with its count.
        }
      })
    ).then(() => {
      if (live) setLoaded((count) => count + 1);
    });
    return () => {
      live = false;
    };
  }, [pins]);
  return loaded;
}

export default function PlacesAppleMap({
  camera,
  pins,
  width,
  height,
  activeKey,
  onRead,
  onCamera,
}: PlacesBasemapProps): React.JSX.Element {
  usePinIcons(pins);
  return (
    <AppleMaps.View
      style={{ height, width }}
      cameraPosition={{
        coordinates: { latitude: camera.lat, longitude: camera.lng },
        zoom: tileZoomFor(camera),
      }}
      // Our pins only — vendor POIs are a competing dataset.
      properties={{
        isMyLocationEnabled: false,
        isTrafficEnabled: false,
        pointsOfInterest: { including: [] },
        selectionEnabled: false,
      }}
      uiSettings={{ myLocationButtonEnabled: false, scaleBarEnabled: true }}
      annotations={pins.map((pin) => {
        const icon = pin.thumb ? icons.get(pin.thumb) : undefined;
        // Anchor to the ground, not the box: pins hold still under a finger.
        const where = coordAt(camera, { height, width }, pin.x, pin.y);
        return {
          id: pin.key,
          coordinates: { latitude: where.lat, longitude: where.lng },
          text: String(pin.count),
          ...(icon ? { icon } : {}),
          ...(pin.key === activeKey ? { title: pin.name ?? undefined } : {}),
        };
      })}
      onCameraMove={(event) => {
        onCamera({
          lat: event.coordinates.latitude ?? camera.lat,
          lng: event.coordinates.longitude ?? camera.lng,
          // Latitude: the axis with uniform degrees (matches Android).
          kmPerPx: kmPerPxForSpan(event.latitudeDelta, height),
        });
      }}
      onMapClick={(event) => {
        const point = projectAt(
          camera,
          { height, width },
          event.coordinates.latitude ?? camera.lat,
          event.coordinates.longitude ?? camera.lng
        );
        onRead(pinAtPoint(pins, point.x, point.y, PIN_TAP_RADIUS));
      }}
    />
  );
}
