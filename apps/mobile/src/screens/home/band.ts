// The band lists FRAME places, never installed apps. Destinations come from
// `./places` pin state, in that table's fixed order. Cap is five destinations
// plus More: a sixth puts every target under 44pt on a 390px screen.
//
// Pure: `bandTabs` takes pinned place ids as an array and never touches storage.

import type { IconName } from "@centraid/design";

import { bandPlaces } from "./places";
import type { Place, PlaceId } from "./places";

/**
 * Invariant 1's hard ceiling: five destinations plus More.
 *
 * A sixth destination puts every target under 44pt on a 390px screen, so this
 * is a constraint, not a preference.
 */
export const MAX_BAND_TABS = 5;

export type BandTarget = PlaceId | "more";

export interface BandTab {
  id: PlaceId;
  name: string;
  /** Band label. Two names do not fit a 61px tab, so this is the table's
   *  `short` field, never a truncated `name`. */
  short: string;
  icon: IconName;
}

function toTab(place: Place): BandTab {
  return {
    icon: place.icon,
    id: place.id,
    name: place.name,
    short: place.short,
  };
}

/**
 * Home first, then pinned places in table order, capped at `MAX_BAND_TABS`.
 * `More` is not in this list — `HomeBand` renders it separately.
 */
export function bandTabs(pinnedIds: readonly PlaceId[]): readonly BandTab[] {
  return bandPlaces(pinnedIds).map(toTab);
}
