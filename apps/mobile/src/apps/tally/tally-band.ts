// The phone band has five destinations: Balances, Activity, Groups, Waiting and
// More. Waiting occupies a slot because it is the only place for another
// member's stuck write; labels come from the shared shelf catalog (#883 B5).
import { moreMeta } from "@centraid/blueprints/apps/tally/route-copy";
import {
  BAND_DESTINATIONS,
  EXPORT,
  MORE_SHELVES,
  RECURRING,
  SEARCH,
  SPENDING,
  TRASH,
  shelfLabel,
} from "@centraid/blueprints/apps/tally/shelves";
import type { ShelfId } from "@centraid/blueprints/apps/tally/shelves";

import { BAND_CAPSULE } from "../../kit/band/band-capsule";
import type { BandCapsule } from "../../kit/band/band-capsule";
import type { BandOwner } from "../../kit/band/band-owner";
import type { TallyStackParamList } from "../../navigation";

// The frame's capsule lives in `kit/band/band-capsule.ts` (#883 B5).
export { BAND_CAPSULE } from "../../kit/band/band-capsule";
export type { BandCapsule } from "../../kit/band/band-capsule";

export type TallyBandDestinationKey =
  | "balances"
  | "activity"
  | "groups"
  | "contrib"
  | "more";

export interface TallyBandDestination {
  key: TallyBandDestinationKey;
  label: string;
  icon: string;
}

export const TALLY_BAND_MAX_DESTINATIONS = 5;

const MORE_ICON = "more-vertical";

export const TALLY_BAND_DESTINATIONS: readonly TallyBandDestination[] = [
  ...BAND_DESTINATIONS.map((destination) => ({
    key: destination.id as TallyBandDestinationKey,
    label: destination.label,
    // The shared table types the glyph as optional because the desktop rail
    // does not draw one; the band always does, so an absent glyph falls back
    // to the sheet's own mark rather than rendering nothing.
    icon: destination.icon ?? MORE_ICON,
  })),
  { key: "more", label: "More", icon: MORE_ICON },
];

export type ResolvedTallyBand =
  | {
      owner: "app";
      destinations: readonly TallyBandDestination[];
      capsule: BandCapsule;
    }
  | { owner: "host" };

export function resolveTallyBand(owner: BandOwner): ResolvedTallyBand {
  if (owner === "host") return { owner: "host" };
  if (TALLY_BAND_DESTINATIONS.length > TALLY_BAND_MAX_DESTINATIONS) {
    throw new Error(
      `Tally claimed ${TALLY_BAND_DESTINATIONS.length} band destinations; the cap is ${TALLY_BAND_MAX_DESTINATIONS}`
    );
  }
  return {
    owner: "app",
    destinations: TALLY_BAND_DESTINATIONS,
    capsule: BAND_CAPSULE,
  };
}

export type TallySurfaceReach = "here" | "elsewhere";

export type TallyMoreRowKey =
  | "recurring"
  | "insight"
  | "search"
  | "trash"
  | "export";

export interface TallyMoreRow {
  key: TallyMoreRowKey;
  shelf: ShelfId;
  label: string;
  meta: string;
  icon: string;
  reach: TallySurfaceReach;
}

const SHEET_KEYS: Readonly<Record<string, TallyMoreRowKey>> = {
  [String(RECURRING)]: "recurring",
  [String(SPENDING)]: "insight",
  [String(SEARCH)]: "search",
  [String(TRASH)]: "trash",
  [String(EXPORT)]: "export",
};

const SHEET_ICONS: Readonly<Record<TallyMoreRowKey, string>> = {
  export: "Upload",
  insight: "Activity",
  recurring: "Clock",
  search: "Search",
  trash: "Trash",
};

const REACHED_HERE: ReadonlySet<TallyMoreRowKey> = new Set([
  "recurring",
  "insight",
  "search",
  "trash",
]);

export const TALLY_MORE_ROWS: readonly TallyMoreRow[] = MORE_SHELVES.map(
  (shelf) => {
    const key = SHEET_KEYS[String(shelf)];
    if (!key) throw new Error(`No More row for shelf ${String(shelf)}`);
    return {
      key,
      shelf,
      label: shelfLabel(shelf),
      meta: moreMeta(shelf),
      icon: SHEET_ICONS[key],
      reach: REACHED_HERE.has(key) ? ("here" as const) : ("elsewhere" as const),
    };
  }
);

export type TallyMoreScreen = Extract<
  keyof TallyStackParamList,
  | "TallyRecurring"
  | "TallySpending"
  | "TallySearch"
  | "TallyTrash"
  | "TallySurface"
>;

export function resolveTallyMoreRoute(key: TallyMoreRowKey): TallyMoreScreen {
  switch (key) {
    case "recurring":
      return "TallyRecurring";
    case "insight":
      return "TallySpending";
    case "search":
      return "TallySearch";
    case "trash":
      return "TallyTrash";
    case "export":
      return "TallySurface";
    default: {
      const exhaustive: never = key;
      throw new Error(`Unhandled More-sheet row: ${String(exhaustive)}`);
    }
  }
}
