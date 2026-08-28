// Tasks gets ONE navigator screen (#834), so a destination is a value here,
// not a route, and the names are the SHARED shelf segments: no place the
// pointer seats cannot address.

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

export function shelfForPlace(place: TasksPlaceKey): ShelfId | undefined {
  return place === "more" ? undefined : shelfFromSegment(place);
}

/** Throws rather than guessing: a shelf with no segment of ours would
 *  otherwise land silently on Today. */
export function morePlace(shelf: ShelfId): TasksMorePlaceKey {
  const segment = shelfSegment(shelf);
  const place = MORE_PLACE_KEYS.find((entry) => entry === segment);
  if (!place) {
    throw new Error(`Shelf ${String(shelf)} is not a More destination`);
  }
  return place;
}

export const TASKS_MORE_PLACES: readonly TasksMorePlaceKey[] =
  MORE_SHELVES.map(morePlace);

export function bandKeyFor(place: TasksPlaceKey): TasksBandDestinationKey {
  if (place === "more") return "more";
  const active = bandActiveId(shelfForPlace(place) ?? null);
  return (
    TASKS_BAND_DESTINATIONS.find(
      (destination) => destination.key === active && destination.key !== "more"
    )?.key ?? "more"
  );
}

export function placeTitle(place: TasksPlaceKey): string {
  return place === "more"
    ? TASKS_MORE_LABEL
    : shelfCopy(shelfForPlace(place) ?? null).title;
}
