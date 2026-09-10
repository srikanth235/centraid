// WHERE A LOCKER ROUTE IS, DERIVED (#1015 Wave 2, audit B7).
//
// Every Locker surface used to write down which band tab it sat under, and
// five of the ten got it right only because the tab and the route happened to
// share a word. Both that tab and the place a pushed surface descends from
// are functions of the ROUTE the surface already declares, so both are
// computed here from `ROUTE_TITLE`'s own keys.
//
// A More surface descends from the APP: the sheet belongs to the frame, so
// "Back to Locker" is the one answer that is never a guess.

import {
  APP_NAME,
  ROUTE_TITLE,
} from "@centraid/blueprints/apps/locker/view-copy";

import { place } from "../../kit/rooms/place";
import type { PlaceRef } from "../../kit/rooms/place";
import type { LockerBandDestinationKey } from "./locker-band";

/** `ROUTE_TITLE`'s keys, so a route cannot invent a name for itself. */
export type LockerRouteKey = keyof typeof ROUTE_TITLE;

/** The four routes that ARE band destinations. `lock` is the wall, which is
 *  Items' own route standing in for it. */
const BAND_ROUTE: ReadonlySet<LockerRouteKey> = new Set<LockerRouteKey>([
  "items",
  "watch",
  "gen",
  "search",
]);

/** Which tab a route lights. Item and Add/edit are under Items; everything
 *  else came through More and lights none of the four. */
const UNDER: Readonly<
  Partial<Record<LockerRouteKey, LockerBandDestinationKey>>
> = {
  edit: "items",
  editNew: "items",
  item: "items",
  lock: "items",
};

export function lockerDestinationFor(
  route: LockerRouteKey
): LockerBandDestinationKey {
  if (BAND_ROUTE.has(route)) return route as LockerBandDestinationKey;
  return UNDER[route] ?? "more";
}

/** True where the route IS one of the four places, rather than under one. */
export function isLockerPlace(route: LockerRouteKey): boolean {
  return BAND_ROUTE.has(route) || route === "lock";
}

// The app, not its first place: a More surface descends to Locker, and the
// root place is `Items` now that the bar agrees with the tab (#1015,
// locker/findings #6).
const APP = place({ key: "Locker", title: APP_NAME });

const PLACE_OF: Readonly<Partial<Record<LockerBandDestinationKey, PlaceRef>>> =
  {
    gen: place({ key: "LockerHome:gen", title: ROUTE_TITLE.gen }),
    items: place({ key: "LockerHome:items", title: ROUTE_TITLE.items }),
    search: place({ key: "LockerHome:search", title: ROUTE_TITLE.search }),
    watch: place({ key: "LockerHome:watch", title: ROUTE_TITLE.watch }),
  };

/** What a pushed Locker surface descends FROM. */
export function lockerParentPlace(route: LockerRouteKey): PlaceRef {
  return PLACE_OF[lockerDestinationFor(route)] ?? APP;
}
