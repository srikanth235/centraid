// The places Tasks has WITHIN its one route (Tasks spec §1–§2; #834).
//
// The navigator gives Tasks ONE screen, so every destination — the four band
// places, the More sheet, the six lenses behind it — is a value this module
// names rather than a route. The names are the SHARED shelf segments, so a
// place cannot exist here that the pointer seats cannot address: `morePlace`
// reads the segment off the shelf table and refuses anything that is not a
// More destination.
//
// No `react-native` import: `tasks-places.test.ts` checks the round trip as
// values.

import {
  MORE_SHELVES,
  bandActiveId,
  shelfFromSegment,
  shelfSegment,
} from "@centraid/blueprints/apps/tasks/shelves";
import type { ShelfId } from "@centraid/blueprints/apps/tasks/shelves";
import { shelfCopy } from "@centraid/blueprints/apps/tasks/view-copy";

import { TASKS_BAND_DESTINATIONS, TASKS_MORE_LABEL } from "./tasks-band";
import type { TasksBandDestinationKey } from "./tasks-band";

/** The six the sheet reaches; each is a shelf segment, spelled once. */
export type TasksMorePlaceKey =
  | "anytime"
  | "all"
  | "search"
  | "logbook"
  | "reentry"
  | "notify";

export type TasksPlaceKey = TasksBandDestinationKey | TasksMorePlaceKey;

const MORE_PLACE_KEYS: readonly TasksMorePlaceKey[] = [
  "anytime",
  "all",
  "search",
  "logbook",
  "reentry",
  "notify",
];

/** The sheet is a place with no shelf: it addresses the others, and the bar
 *  never carries its own name. */
export function shelfForPlace(place: TasksPlaceKey): ShelfId | undefined {
  return place === "more" ? undefined : shelfFromSegment(place);
}

/** The place a More row leads to. Throws rather than guessing: a shelf that
 *  carries no segment of ours would otherwise land silently on Today. */
export function morePlace(shelf: ShelfId): TasksMorePlaceKey {
  const segment = shelfSegment(shelf);
  const place = MORE_PLACE_KEYS.find((entry) => entry === segment);
  if (!place) {
    throw new Error(`Shelf ${String(shelf)} is not a More destination`);
  }
  return place;
}

/** The sheet's destinations in the sheet's own order. */
export const TASKS_MORE_PLACES: readonly TasksMorePlaceKey[] =
  MORE_SHELVES.map(morePlace);

/** Which band tab is lit. A lens behind the sheet lights More, because the
 *  sheet is how the member got there and no other tab is where they are. */
export function bandKeyFor(place: TasksPlaceKey): TasksBandDestinationKey {
  if (place === "more") return "more";
  const active = bandActiveId(shelfForPlace(place) ?? null);
  return (
    TASKS_BAND_DESTINATIONS.find(
      (destination) => destination.key === active && destination.key !== "more"
    )?.key ?? "more"
  );
}

/** The place's name, in the web app's own words. */
export function placeTitle(place: TasksPlaceKey): string {
  return place === "more"
    ? TASKS_MORE_LABEL
    : shelfCopy(shelfForPlace(place) ?? null).title;
}
