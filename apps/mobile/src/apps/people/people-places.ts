// WHERE A PEOPLE ROUTE IS, DERIVED (#1015 Wave 2, audit B7).
//
// Six People surfaces drew their own `BackRow`, and each one decided for
// itself what to call the place it descended from — three said the app's
// name, three said a person's, and nothing checked either. The route table is
// here instead: what a route is called, which band tab it lights, and whether
// its parent is the roster or the person it is about.
//
// The person's own name is minted as a place at the call site, because it is
// the only title in this app that is data rather than copy.

import {
  APP_TITLE,
  ROUTE_TITLES,
  SEARCH_TITLE,
  TOUCH_TITLE,
} from "@centraid/blueprints/apps/people/people-copy";

import { place } from "../../kit/rooms/place";
import type { PlaceRef } from "../../kit/rooms/place";
import type { PeopleBandKey } from "./people-band";

/** Every People route: the three places, then what is pushed over them. */
export type PeopleRouteKey =
  | PeopleBandKey
  | "person"
  | "trash"
  | "newPerson"
  | "editPerson"
  | "merge"
  | "logTouch";

const PLACES: ReadonlySet<PeopleRouteKey> = new Set<PeopleRouteKey>([
  "people",
  "touch",
  "search",
]);

/** True where the route IS one of the three places rather than over one. */
export function isPeoplePlace(route: PeopleRouteKey): boolean {
  return PLACES.has(route);
}

/** Which band tab a route lights. Everything pushed is over the roster except
 *  the touch log, which is over Touch — where the member was looking. */
export function peopleDestinationFor(route: PeopleRouteKey): PeopleBandKey {
  if (PLACES.has(route)) return route as PeopleBandKey;
  return route === "logTouch" ? "touch" : "people";
}

/** The route's own word. A person's route is titled with their name, which is
 *  data, so the caller passes it. */
export function peopleTitleFor(
  route: PeopleRouteKey,
  subject?: string
): string {
  switch (route) {
    case "people":
      return APP_TITLE;
    case "touch":
      return TOUCH_TITLE;
    case "search":
      return SEARCH_TITLE;
    case "person":
      return subject ?? APP_TITLE;
    default:
      return ROUTE_TITLES[route];
  }
}

/** The roster — the parent of everything that is not about one person. */
export const PEOPLE_ROSTER: PlaceRef = place({
  key: "PeopleHome",
  title: APP_TITLE,
});

const TOUCH_LOG: PlaceRef = place({ key: "PeopleTouch", title: TOUCH_TITLE });

/** One person, as a place: the only title in People that is data. */
export function personPlace(name: string, partyId: string): PlaceRef {
  return place({ key: `Person:${partyId}`, title: name });
}

/**
 * What a pushed People surface descends FROM. Editing, merging and logging a
 * touch are all ABOUT one person and descend from them when their name is
 * known; everything else descends from the roster.
 */
export function peopleParentPlace(
  route: PeopleRouteKey,
  subject?: PlaceRef
): PlaceRef {
  switch (route) {
    case "editPerson":
    case "merge":
      return subject ?? PEOPLE_ROSTER;
    case "logTouch":
      return subject ?? TOUCH_LOG;
    default:
      return PEOPLE_ROSTER;
  }
}
