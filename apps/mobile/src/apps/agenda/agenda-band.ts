import { BAND_DESTINATIONS } from "@centraid/blueprints/apps/agenda/views";

import { BAND_CAPSULE } from "../../kit/band/band-capsule";
import type { BandCapsule } from "../../kit/band/band-capsule";
import type { BandOwner } from "../../kit/band/band-owner";

export { BAND_CAPSULE } from "../../kit/band/band-capsule";
export type { BandCapsule } from "../../kit/band/band-capsule";

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

export type AgendaBandModel =
  | { owner: "host"; capsule: BandCapsule }
  | {
      owner: "app";
      capsule: BandCapsule;
      destinations: readonly AgendaBandDestination[];
    };

export function resolveAgendaBand(owner: BandOwner): AgendaBandModel {
  if (owner !== "app") return { owner: "host", capsule: BAND_CAPSULE };
  return {
    owner: "app",
    capsule: BAND_CAPSULE,
    destinations: AGENDA_BAND_DESTINATIONS.slice(
      0,
      AGENDA_BAND_MAX_DESTINATIONS
    ),
  };
}
