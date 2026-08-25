// MAPKIT, through `expo-maps` — the iOS half of the real map (#816).
//
// iOS only, and that is a choice rather than a platform limit: `expo-maps`
// draws Google Maps on Android, which means an API key and Play Services. The
// Android half is MapLibre over OpenFreeMap (`places-map-libre.tsx`). MapKit
// asks for no key at all and is already on the device.
//
// This module is reached only through `React.lazy` (`PlacesRealMap.tsx`).
// Importing it evaluates `expo-maps`, which registers a native view; nothing
// on the private sketch, on Android, or in a test runner should pay for that.
//
// TWO THINGS THE SDK CANNOT DO FOR US, both decided upstream in
// `PlacesRealMap`/`place-map.ts` and merely OBEYED here:
//
//   1. CLUSTERING. `expo-maps` has none — there is not one occurrence of the
//      word in the package. Ours arrives as `pins`, already merged in pixel
//      space with the tier's ground floor under it, which is also what the
//      Android map and the web shelf draw.
//   2. PIN PRESSES. `onAnnotationClick` is documented `ios 18.0+`, and this
//      app's deployment target is 17.5 (`app.config.ts`). Wiring the pin to it
//      would ship a map whose photographs do nothing on iOS 17, silently. So
//      the unconditional `onMapClick` carries the tap, its coordinate is
//      projected back into the drawing, and `pinAtPoint` says which pin the
//      finger was on. Raising the floor to iOS 18 to buy an event is not a
//      trade this product would make.
//
// The pin is the PHOTOGRAPH here too, which is why these are `annotations` and
// not `markers`: a plain marker takes an SF Symbol or a monogram, and only an
// annotation takes an `icon`. The icons are loaded through `expo-image` into a
// process-wide cache, because a camera move re-projects every pin and reading
// the same picture off disk on every pan would be work with no result.

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

/**
 * One decoded picture per place, for as long as the process lives.
 *
 * Keyed by the URI rather than by the pin, because a pin's key changes the
 * moment a merge changes and the picture behind it did not. A member panning a
 * map re-projects on every frame the SDK reports; without this, every pan
 * would re-read the same handful of thumbnails.
 */
const icons = new Map<string, ImageRef>();

function usePinIcons(pins: readonly MapPin[]): number {
  // A counter rather than the map itself: the cache is shared and mutable, so
  // what a render needs to know is only that it grew.
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
          // A pin whose picture would not decode is still a pin: it draws with
          // its count alone rather than taking the map down with it.
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
      // Nothing but the base layer and our own pins. Points of interest are
      // excluded outright: this map answers "where have I been", and a
      // scattering of the vendor's restaurants over a member's own places is
      // a second, unrelated dataset competing with the answer.
      properties={{
        isMyLocationEnabled: false,
        isTrafficEnabled: false,
        pointsOfInterest: { including: [] },
        selectionEnabled: false,
      }}
      uiSettings={{ myLocationButtonEnabled: false, scaleBarEnabled: true }}
      annotations={pins.map((pin) => {
        const icon = pin.thumb ? icons.get(pin.thumb) : undefined;
        // An annotation is anchored to the GROUND, not to the box, so it holds
        // still under a finger while the map moves. `coordAt` runs the
        // projection backwards to ask where the pin's pixel actually is.
        const where = coordAt(camera, { height, width }, pin.x, pin.y);
        return {
          id: pin.key,
          coordinates: { latitude: where.lat, longitude: where.lng },
          // The count, on the picture — the same numeral the sketch prints.
          text: String(pin.count),
          ...(icon ? { icon } : {}),
          ...(pin.key === activeKey ? { title: pin.name ?? undefined } : {}),
        };
      })}
      onCameraMove={(event) => {
        onCamera({
          lat: event.coordinates.latitude ?? camera.lat,
          lng: event.coordinates.longitude ?? camera.lng,
          // MapKit reports the visible region as a slice of latitude, which is
          // the one axis whose degrees are the same length everywhere — so
          // this is the same number MapLibre's bounds yield on Android.
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
