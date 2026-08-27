// Tally's claim on the phone's bottom band (Tally spec §1, "Phone band"):
// **Balances · Activity · Groups · Waiting** plus the frame's More — four
// destinations and a sheet, the invariant's exact cap.
//
// WAITING HOLDS A SLOT and that is a sanctioned divergence from "four places
// that are places": it is the only surface in Tally where a write can be
// somebody else's and stuck, and there is nowhere else to look for it. NO
// COUNT IN THE BAND — a queue with a number on it is a badge, and Waiting says
// how many while the member is standing in it.
//
// Ids and labels come from `apps/tally/shelves.ts`, so the band, the desktop
// rail and the app bar cannot disagree about what a place is called. No
// `react-native` import here: `tally-band.test.ts` asserts these tables
// directly and `TallyBand.tsx` renders them unchanged.
//
// AND THE SHEET'S OTHER HALF — Export is a `custodian` surface in SURFACES.md,
// so this phone has no door to it. It is drawn as a row that says where the act
// happens rather than as a control that would go grey, because a disabled
// Export teaches that Export is broken.

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

import type { BandOwner } from "../../kit/band/band-owner";
import type { TallyStackParamList } from "../../navigation";

export type TallyBandDestinationKey =
  | "balances"
  | "activity"
  | "groups"
  | "contrib"
  | "more";

export interface TallyBandDestination {
  key: TallyBandDestinationKey;
  /** Copy is final — these five words ARE the band. */
  label: string;
  icon: string;
}

/** The frame band's cap, hence a claiming app's: five, the fifth being More. */
export const TALLY_BAND_MAX_DESTINATIONS = 5;

export const TALLY_BAND_CAPSULE_SIZE = 52;

const MORE_ICON = "more-vertical";

/** The four the blueprint declares, then the sheet. */
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

/** The frame's capsule — a frame control, never a sixth tab of the app's. */
export interface TallyBandCapsule {
  label: "Home";
  icon: "Home";
  size: number;
  edge: "leading";
  /** `false` is the whole reason it is not a sixth tab. */
  inTabGroup: false;
}

export const TALLY_BAND_CAPSULE: TallyBandCapsule = {
  label: "Home",
  icon: "Home",
  size: TALLY_BAND_CAPSULE_SIZE,
  edge: "leading",
  inTabGroup: false,
};

export type ResolvedTallyBand =
  | {
      owner: "app";
      destinations: readonly TallyBandDestination[];
      capsule: TallyBandCapsule;
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
    capsule: TALLY_BAND_CAPSULE,
  };
}

// ─── The More sheet ─────────────────────────────────────────────────────────

/** Where a More row's act actually happens, from this seat. `here` is a route
 *  on this phone; `elsewhere` is a surface whose door is on another seat, and
 *  the row says which rather than offering a control with nothing behind it. */
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

/** The four lenses this seat performs. Export is `custodian` in SURFACES.md's
 *  seat column — its door is beside the gateway — so it is the one row that
 *  states where the act happens instead of performing it. */
const REACHED_HERE: ReadonlySet<TallyMoreRowKey> = new Set([
  "recurring",
  "insight",
  "search",
  "trash",
]);

/** Rows keyed to the SHARED shelf ids, in the shared sheet's own order, with
 *  labels and meta taken from the shared tables rather than respelled here. */
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

/** Exhaustive: a row without a route fails typecheck, not at tap. Every row
 *  leads somewhere — Export shares one screen that states what it is and where
 *  the act happens. */
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
