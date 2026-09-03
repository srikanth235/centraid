import {
  SURFACE_META,
  SURFACE_TITLE,
} from "@centraid/blueprints/apps/locker/route-copy";
import {
  ACCESS,
  BAND_DESTINATIONS,
  EXPORT,
  FILL,
  IMPORT,
  MORE_SHELVES,
  TRASH,
} from "@centraid/blueprints/apps/locker/shelves";
import type { ShelfId } from "@centraid/blueprints/apps/locker/shelves";

import { BAND_CAPSULE } from "../../kit/band/band-capsule";
import type { BandCapsule } from "../../kit/band/band-capsule";
import type { BandOwner } from "../../kit/band/band-owner";
import type { LockerStackParamList } from "../../navigation";

export { BAND_CAPSULE } from "../../kit/band/band-capsule";
export type { BandCapsule } from "../../kit/band/band-capsule";

export type LockerBandDestinationKey =
  | "items"
  | "watch"
  | "gen"
  | "search"
  | "more";

export interface LockerBandDestination {
  key: LockerBandDestinationKey;
  label: string;
  icon: string;
}

export const LOCKER_BAND_MAX_DESTINATIONS = 5;

const MORE_ICON = "more-vertical";

export const LOCKER_BAND_DESTINATIONS: readonly LockerBandDestination[] = [
  ...BAND_DESTINATIONS.map((destination) => ({
    key: destination.id as LockerBandDestinationKey,
    label: destination.label,
    icon: destination.icon ?? MORE_ICON,
  })),
  { key: "more", label: "More", icon: MORE_ICON },
];

export type ResolvedLockerBand =
  | {
      owner: "app";
      destinations: readonly LockerBandDestination[];
      capsule: BandCapsule;
    }
  | { owner: "host" };

export function resolveLockerBand(owner: BandOwner): ResolvedLockerBand {
  if (owner === "host") return { owner: "host" };
  if (LOCKER_BAND_DESTINATIONS.length > LOCKER_BAND_MAX_DESTINATIONS) {
    throw new Error(
      `Locker claimed ${LOCKER_BAND_DESTINATIONS.length} band destinations; the cap is ${LOCKER_BAND_MAX_DESTINATIONS}`
    );
  }
  return {
    owner: "app",
    destinations: LOCKER_BAND_DESTINATIONS,
    capsule: BAND_CAPSULE,
  };
}

export type LockerSurfaceReach = "here" | "elsewhere";

export type LockerMoreRowKey =
  | "import"
  | "access"
  | "trash"
  | "export"
  | "fill";

export interface LockerMoreRow {
  key: LockerMoreRowKey;
  shelf: ShelfId;
  label: string;
  meta: string;
  icon: string;
  reach: LockerSurfaceReach;
}

const SHEET_KEYS: Readonly<Record<string, LockerMoreRowKey>> = {
  [String(IMPORT)]: "import",
  [String(ACCESS)]: "access",
  [String(TRASH)]: "trash",
  [String(EXPORT)]: "export",
  [String(FILL)]: "fill",
};

const SHEET_ICONS: Readonly<Record<LockerMoreRowKey, string>> = {
  access: "Clock",
  export: "Upload",
  fill: "Globe",
  import: "Download",
  trash: "Trash",
};

const REACHED_HERE: ReadonlySet<LockerMoreRowKey> = new Set([
  "access",
  "export",
  "import",
  "trash",
]);

export const LOCKER_MORE_ROWS: readonly LockerMoreRow[] = MORE_SHELVES.map(
  (shelf) => {
    const key = SHEET_KEYS[String(shelf)];
    if (!key) throw new Error(`No More row for shelf ${String(shelf)}`);
    const label = SURFACE_TITLE[String(shelf)];
    const meta = SURFACE_META[String(shelf)];
    if (!label || !meta)
      throw new Error(`No shared More copy for shelf ${String(shelf)}`);
    return {
      key,
      shelf,
      label,
      meta,
      icon: SHEET_ICONS[key],
      reach: REACHED_HERE.has(key) ? ("here" as const) : ("elsewhere" as const),
    };
  }
);

export type LockerMoreScreen = Extract<
  keyof LockerStackParamList,
  "LockerAccess" | "LockerTrash" | "LockerSurface"
>;

export function resolveLockerMoreRoute(
  key: LockerMoreRowKey
): LockerMoreScreen {
  switch (key) {
    case "access":
      return "LockerAccess";
    case "trash":
      return "LockerTrash";
    case "import":
    case "export":
    case "fill":
      return "LockerSurface";
    default: {
      const exhaustive: never = key;
      throw new Error(`Unhandled More-sheet row: ${String(exhaustive)}`);
    }
  }
}
