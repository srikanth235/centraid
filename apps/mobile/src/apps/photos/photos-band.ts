import { BAND_CAPSULE } from "../../kit/band/band-capsule";
import type { BandCapsule } from "../../kit/band/band-capsule";
import type { BandOwner } from "../../kit/band/band-owner";

export { BAND_CAPSULE } from "../../kit/band/band-capsule";
export type { BandCapsule } from "../../kit/band/band-capsule";

export type BandDestinationKey = "library" | "collections" | "search" | "more";

export interface BandDestination {
  key: BandDestinationKey;
  label: string;
  icon: string;
}

export const BAND_MAX_DESTINATIONS = 5;

export const TARGET_MIN = 44;

export const PHOTOS_BAND_DESTINATIONS: readonly BandDestination[] = [
  { key: "library", label: "Library", icon: "image" },
  { key: "collections", label: "Collections", icon: "Layers" },
  { key: "search", label: "Search", icon: "search" },
  { key: "more", label: "More", icon: "more-vertical" },
];

export type PhotosMoreRowKey = "backup";

export interface MoreRow {
  key: PhotosMoreRowKey;
  label: string;
  icon: string;
  meta?: string;
}

export const PHOTOS_MORE_ROWS: readonly MoreRow[] = [
  { key: "backup", label: "Backup", icon: "archive" },
];

export const PHOTOS_MORE_FOOT = "Everything Photos can show.";

export type MoreRowRoute = {
  screen: "Settings";
  params: { screen: "BackupHealth" };
};

export function resolveMoreRowRoute(key: PhotosMoreRowKey): MoreRowRoute {
  switch (key) {
    case "backup":
      return { screen: "Settings", params: { screen: "BackupHealth" } };
    default: {
      const exhaustive: never = key;
      throw new Error(`Unhandled More-sheet row: ${String(exhaustive)}`);
    }
  }
}

export type ResolvedBand =
  | {
      owner: "app";
      destinations: readonly BandDestination[];
      capsule: BandCapsule;
    }
  | { owner: "host" };

export function resolveBand(owner: BandOwner): ResolvedBand {
  if (owner === "host") return { owner: "host" };
  if (PHOTOS_BAND_DESTINATIONS.length > BAND_MAX_DESTINATIONS) {
    throw new Error(
      `Photos claimed ${PHOTOS_BAND_DESTINATIONS.length} band destinations; the cap is ${BAND_MAX_DESTINATIONS}`
    );
  }
  return {
    owner: "app",
    destinations: PHOTOS_BAND_DESTINATIONS,
    capsule: BAND_CAPSULE,
  };
}
