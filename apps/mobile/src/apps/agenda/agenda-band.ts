// The phone's bottom band: `BAND_DESTINATIONS` plus More (frame cap, five).
// ONE table, so the seats cannot disagree over Search or over Month.

import { BAND_DESTINATIONS } from "@centraid/blueprints/apps/agenda/views";

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

const MORE_ICON = "MoreVert";

export const AGENDA_BAND_DESTINATIONS: readonly AgendaBandDestination[] = [
  ...BAND_DESTINATIONS.map((destination) => {
    if (!destination.icon)
      throw new Error(`No icon for band destination ${destination.id}`);
    return {
      key: destination.id as AgendaBandDestinationKey,
      label: destination.label,
      icon: destination.icon,
    };
  }),
  { key: "more", label: "More", icon: MORE_ICON },
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
