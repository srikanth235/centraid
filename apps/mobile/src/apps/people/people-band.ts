// People's compact band (#821): People · Touch · Search, plus the frame Home
// capsule. Three is a sanctioned deviation from "four or more may claim"
// (handoff § Deviations 2): each holds distinct work; a segmented control
// is not one-handed. No More — Trash is a roster app-bar verb. Free of
// `react-native` so the rules assert without a renderer.

import {
  APP_TITLE,
  SEARCH_TITLE,
  TOUCH_TITLE,
} from "@centraid/blueprints/apps/people/people-copy";

import { BAND_CAPSULE } from "../../kit/band/band-capsule";
import type { BandCapsule } from "../../kit/band/band-capsule";
import type { BandOwner } from "../../kit/band/band-owner";

// The frame's capsule lives in `kit/band/band-capsule.ts` (#883 B5); only the
// TYPE is re-exported here.
export type { BandCapsule } from "../../kit/band/band-capsule";

export type PeopleBandKey = "people" | "touch" | "search";

export interface PeopleBandDestination {
  key: PeopleBandKey;
  label: string;
  icon: string;
}

/** Claiming-app cap (five; fifth is More). People uses three and no More. */
export const PEOPLE_BAND_MAX = 5;

export const PEOPLE_BAND_DESTINATIONS: readonly PeopleBandDestination[] = [
  { key: "people", label: APP_TITLE, icon: "users" },
  { key: "touch", label: TOUCH_TITLE, icon: "clock" },
  { key: "search", label: SEARCH_TITLE, icon: "search" },
];

/**
 * Exactly one band: `host` drops the tab group and keeps the capsule — a claim
 * may never remove the way out (`PeopleBand.tsx`).
 */
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
