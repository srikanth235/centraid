// The phone's bottom band, as People claims it (Binding Layer v12 handoff,
// Part 1 § Navigation; #821).
//
// People claims the band with THREE destinations — People · Touch · Search —
// plus the frame's Home capsule at the leading edge. Three is a sanctioned
// deviation from the platform's own "four or more may claim" rule (handoff
// § Deviations 2): each of the three holds distinct work, and the alternative
// is a segmented control the thumb cannot reach one-handed. There is no More
// sheet — the app has nothing the three cannot carry (Trash is a verb on the
// roster's app bar, not a shelf).
//
// The anatomy — two plates in a transparent row, the capsule outside the tab
// group — is Photos' (`../photos/photos-band.ts`), stated once for both in
// `kit/band-surface.ts`. This module is deliberately free of `react-native`
// imports so the rules can be asserted directly; `PeopleBand.tsx` renders
// them and adds nothing.

import {
  APP_TITLE,
  SEARCH_TITLE,
  TOUCH_TITLE,
} from "@centraid/blueprints/apps/people/people-copy";

import type { BandOwner } from "../../kit/band/band-owner";

/** The capsule's width (the handoff's `width:52px`; its height comes from the
 *  row's `align-items:stretch`). Photos states the same number in its own
 *  band module; apps may not import each other (`check-import-boundaries.ts`),
 *  and the shared home for it would be `kit/band-surface.ts` — a kit move the
 *  frame owns, recorded in `INTEGRATION-NOTES.md` rather than made here. */
export const PEOPLE_BAND_CAPSULE_SIZE = 52;

/** A destination in People's claimed band. All three are ONE screen
 *  (`PeopleHome`) showing a different body — the frozen route contract's
 *  `destination` param, the same shape Photos and Docs use. */
export type PeopleBandKey = "people" | "touch" | "search";

export interface PeopleBandDestination {
  key: PeopleBandKey;
  /** Copy is final — the three band words come from `people-copy.ts`. */
  label: string;
  icon: string;
}

/** The cap a claiming app lives under (five, of which the fifth is More).
 *  People uses three of them and no More. */
export const PEOPLE_BAND_MAX = 5;

/**
 * People's three, in this order on every compact surface: the roster first —
 * finding a person is what a member reaches for most — then Touch (what needs
 * doing), then Search.
 */
export const PEOPLE_BAND_DESTINATIONS: readonly PeopleBandDestination[] = [
  { key: "people", label: APP_TITLE, icon: "users" },
  { key: "touch", label: TOUCH_TITLE, icon: "clock" },
  { key: "search", label: SEARCH_TITLE, icon: "search" },
];

/** The frame's capsule — a frame control, never one of the app's tabs. The
 *  shape mirrors Photos' `BandCapsule` (leading edge, outside the group). */
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
 * The band, resolved against the frame's owner latch. Exactly one band exists
 * at any moment: when the member has handed the band back (`host`) the app's
 * tab group goes and the capsule stays — the way out of the app is the one
 * thing a claim may never remove (see `PeopleBand.tsx`).
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
