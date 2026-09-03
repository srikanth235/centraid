import type { IconName } from "@centraid/design";

import { bandPlaces } from "./places";
import type { Place, PlaceId } from "./places";

export const MAX_BAND_TABS = 5;

export type BandTarget = PlaceId | "more";

export interface BandTab {
  id: PlaceId;
  name: string;
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

export function bandTabs(pinnedIds: readonly PlaceId[]): readonly BandTab[] {
  return bandPlaces(pinnedIds).map(toTab);
}
