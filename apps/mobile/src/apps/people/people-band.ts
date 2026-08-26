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

import type { BandOwner } from "../../kit/band/band-owner";

/** Capsule width (handoff `width:52px`; height from `align-items:stretch`).
 *  Photos states the same number; apps may not import each other
 *  (`check-import-boundaries.ts`). Shared home would be `kit/band-surface.ts`. */
export const PEOPLE_BAND_CAPSULE_SIZE = 52;

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

/** Frame control, never an app tab. Mirrors Photos' leading `BandCapsule`. */
export interface PeopleBandCapsule {
  label: "Home";
  icon: "home";
  size: number;
  edge: "leading";
  inTabGroup: false;
}

export const PEOPLE_BAND_CAPSULE: PeopleBandCapsule = {
  label: "Home",
  icon: "home",
  size: PEOPLE_BAND_CAPSULE_SIZE,
  edge: "leading",
  inTabGroup: false,
};

/**
 * Exactly one band: `host` drops the tab group and keeps the capsule — a claim
 * may never remove the way out (`PeopleBand.tsx`).
 */
export type ResolvedPeopleBand =
  | {
      owner: "app";
      destinations: readonly PeopleBandDestination[];
      capsule: PeopleBandCapsule;
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
    capsule: PEOPLE_BAND_CAPSULE,
  };
}
