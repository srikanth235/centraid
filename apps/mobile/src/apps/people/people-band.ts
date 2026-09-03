import {
  APP_TITLE,
  SEARCH_TITLE,
  TOUCH_TITLE,
} from "@centraid/blueprints/apps/people/people-copy";

import { BAND_CAPSULE } from "../../kit/band/band-capsule";
import type { BandCapsule } from "../../kit/band/band-capsule";
import type { BandOwner } from "../../kit/band/band-owner";

export type { BandCapsule } from "../../kit/band/band-capsule";

export type PeopleBandKey = "people" | "touch" | "search";

export interface PeopleBandDestination {
  key: PeopleBandKey;
  label: string;
  icon: string;
}

export const PEOPLE_BAND_MAX = 5;

export const PEOPLE_BAND_DESTINATIONS: readonly PeopleBandDestination[] = [
  { key: "people", label: APP_TITLE, icon: "users" },
  { key: "touch", label: TOUCH_TITLE, icon: "clock" },
  { key: "search", label: SEARCH_TITLE, icon: "search" },
];

export type ResolvedPeopleBand =
  | {
      owner: "app";
      destinations: readonly PeopleBandDestination[];
      capsule: BandCapsule;
    }
  | { owner: "host" };

export function resolvePeopleBand(owner: BandOwner): ResolvedPeopleBand {
  if (owner === "host") return { owner: "host" };
  if (PEOPLE_BAND_DESTINATIONS.length > PEOPLE_BAND_MAX) {
    throw new Error(
      `People claimed ${PEOPLE_BAND_DESTINATIONS.length} band destinations; the cap is ${PEOPLE_BAND_MAX}`
    );
  }
  return {
    owner: "app",
    destinations: PEOPLE_BAND_DESTINATIONS,
    capsule: BAND_CAPSULE,
  };
}
