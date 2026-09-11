// WHERE A PHOTOS ROUTE IS, DERIVED (#1015 Wave 2, audit B7 and S2).
//
// Seven pushed Photos surfaces named `more` as their band tab and then drew their own
// chevron, because the band highlighted a destination none of them was
// reached from — the band named the wrong place and could not be the exit.
// The route table is here instead: the word in the header, the band tab, and
// the place a pushed surface actually descends from.

import { place } from "../../kit/rooms/place";
import type { PlaceRef } from "../../kit/rooms/place";
import type { BandDestinationKey } from "./photos-band";

/** Every Photos route: the three places, then what is pushed over them. */
export type PhotosRouteKey =
  | "library"
  | "collections"
  | "search"
  | "album"
  | "picker"
  | "people"
  | "places"
  | "placesMap"
  | "placeDetail"
  | "faceReview"
  | "memories"
  | "duplicates"
  | "duplicateReview"
  | "state";

const PLACES: ReadonlySet<PhotosRouteKey> = new Set<PhotosRouteKey>([
  "library",
  "collections",
  "search",
]);

/** True where the route IS a band destination rather than pushed over one. */
export function isPhotosPlace(route: PhotosRouteKey): boolean {
  return PLACES.has(route);
}

const UNDER: Readonly<Partial<Record<PhotosRouteKey, BandDestinationKey>>> = {
  album: "collections",
  picker: "collections",
};

/** Which band tab a route lights. */
export function photosDestinationFor(
  route: PhotosRouteKey
): BandDestinationKey {
  if (PLACES.has(route)) return route as BandDestinationKey;
  return UNDER[route] ?? "more";
}

/** The app's own place — the honest parent of anything opened from More. */
export const PHOTOS = place({ key: "PhotosHome", title: "Photos" });
const COLLECTIONS = place({
  key: "PhotosHome:collections",
  title: "Collections",
});
const PLACES_SHELF = place({ key: "PhotosPlaces", title: "Places" });
const DUPLICATES = place({ key: "PhotosDuplicates", title: "Duplicates" });

/**
 * What a pushed Photos surface descends FROM. A place's detail descends from
 * the Places shelf and a duplicate review from the Duplicates shelf, because
 * those are where they are opened; everything else opened through More
 * descends from the app.
 */
export function photosParentPlace(route: PhotosRouteKey): PlaceRef {
  switch (route) {
    case "album":
    case "picker":
      return COLLECTIONS;
    case "placeDetail":
    case "placesMap":
      return PLACES_SHELF;
    case "duplicateReview":
      return DUPLICATES;
    default:
      return PHOTOS;
  }
}
