// The phone's bottom band, as Agenda claims it.
//
// FOUR DESTINATIONS PLUS MORE, which is inside the frame's cap of five. Each
// destination is a VIEW rather than a route: Agenda has one route and its
// views are its places, so the band switches what `AgendaHome` is showing and
// never pushes a second screen.
//
// Month and Week are absent by design. A seven-column grid at 390px gives
// 42pt cells, under the 44pt tap-target floor, so on touch both fall back to
// Day — the same fallback the web surface makes at a narrow width.
//
// The MODEL is restated here rather than imported from another app's band
// (`scripts/check-import-boundaries.ts` forbids app-to-app imports); what the
// bands share structurally already lives in `kit/band-surface.ts`.

import type { BandOwner } from "../../kit/band/band-owner";

/** A destination in the claimed band. `more` opens the sheet, not a route. */
export type AgendaBandDestinationKey =
  | "day"
  | "schedule"
  | "waiting"
  | "search"
  | "more";

export interface AgendaBandDestination {
  key: AgendaBandDestinationKey;
  label: string;
  icon: string;
}

/** The cap the frame's band lives under, and therefore the cap a claiming app
 *  lives under: five destinations, of which the fifth is More. */
export const AGENDA_BAND_MAX_DESTINATIONS = 5;

/** The frame capsule's width; height comes from the row's `align-items:
 *  stretch`, the same as every other band. */
export const AGENDA_BAND_CAPSULE_SIZE = 52;

export const AGENDA_BAND_DESTINATIONS: readonly AgendaBandDestination[] = [
  { key: "day", label: "Day", icon: "Clock" },
  { key: "schedule", label: "Schedule", icon: "List" },
  { key: "waiting", label: "Waiting on", icon: "Users" },
  { key: "search", label: "Search", icon: "Search" },
  { key: "more", label: "More", icon: "MoreVert" },
];

export interface AgendaBandCapsule {
  label: "Home";
  icon: "Home";
  size: number;
}

/** The frame's capsule — a frame control, never one of the app's tabs. It
 *  stays even when the member has handed the band back, because the way home
 *  is the one thing an app may never take away. */
export const AGENDA_BAND_CAPSULE: AgendaBandCapsule = {
  label: "Home",
  icon: "Home",
  size: AGENDA_BAND_CAPSULE_SIZE,
};

export type AgendaBandModel =
  | { owner: "host"; capsule: AgendaBandCapsule }
  | {
      owner: "app";
      capsule: AgendaBandCapsule;
      destinations: readonly AgendaBandDestination[];
    };

/** What the band renders, given who owns it. */
export function resolveAgendaBand(owner: BandOwner): AgendaBandModel {
  if (owner !== "app") return { owner: "host", capsule: AGENDA_BAND_CAPSULE };
  return {
    owner: "app",
    capsule: AGENDA_BAND_CAPSULE,
    destinations: AGENDA_BAND_DESTINATIONS.slice(
      0,
      AGENDA_BAND_MAX_DESTINATIONS
    ),
  };
}
