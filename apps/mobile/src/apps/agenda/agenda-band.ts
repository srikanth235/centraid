// Five VIEW destinations max (frame cap); views switch, never push. No
// Month/Week (<44pt cells on touch → Day); no app-to-app imports either.

import type { BandOwner } from "../../kit/band/band-owner";

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

export const AGENDA_BAND_MAX_DESTINATIONS = 5;

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

/** Frame control, never an app tab; stays even when the band is handed back. */
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
