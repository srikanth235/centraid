// Locker's claim on the phone's bottom band (README-Locker §1, "Phone band"):
// **Items · Review · Generate · Search** plus the frame's More — four
// destinations and a sheet, the invariant's exact cap.
//
// Ids and labels come from `apps/locker/shelves.ts`, so the band, the desktop
// rail and the app bar cannot disagree about what a place is called. No
// `react-native` import here: `locker-band.test.ts` asserts these tables
// directly and `LockerBand.tsx` renders them unchanged.
//
// AND THE SHEET'S OTHER HALF — the surfaces this seat cannot perform. Import
// and Export are custodian surfaces (SURFACES.md) and Companion runs in a
// browser extension; none of them has a door on a phone. They are drawn as
// rows that say where the act happens rather than as controls that would go
// grey, because a disabled Import teaches that Import is broken.

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

import type { BandOwner } from "../../kit/band/band-owner";
import type { LockerStackParamList } from "../../navigation";

export type LockerBandDestinationKey =
  | "items"
  | "watch"
  | "gen"
  | "search"
  | "more";

export interface LockerBandDestination {
  key: LockerBandDestinationKey;
  /** Copy is final — these five words ARE the band. */
  label: string;
  icon: string;
}

/** The frame band's cap, hence a claiming app's: five, the fifth being More. */
export const LOCKER_BAND_MAX_DESTINATIONS = 5;

export const LOCKER_BAND_CAPSULE_SIZE = 52;

const MORE_ICON = "more-vertical";

/** The four the blueprint declares, then the sheet. */
export const LOCKER_BAND_DESTINATIONS: readonly LockerBandDestination[] = [
  ...BAND_DESTINATIONS.map((destination) => ({
    key: destination.id as LockerBandDestinationKey,
    label: destination.label,
    // The shared table types the glyph as optional because the desktop rail
    // does not draw one; the band always does, so an absent glyph falls back
    // to the sheet's own mark rather than rendering nothing.
    icon: destination.icon ?? MORE_ICON,
  })),
  { key: "more", label: "More", icon: MORE_ICON },
];

/** The frame's capsule — a frame control, never a sixth tab of the app's. */
export interface LockerBandCapsule {
  label: "Home";
  icon: "Home";
  size: number;
  edge: "leading";
  /** `false` is the whole reason it is not a sixth tab. */
  inTabGroup: false;
}

export const LOCKER_BAND_CAPSULE: LockerBandCapsule = {
  label: "Home",
  icon: "Home",
  size: LOCKER_BAND_CAPSULE_SIZE,
  edge: "leading",
  inTabGroup: false,
};

export type ResolvedLockerBand =
  | {
      owner: "app";
      destinations: readonly LockerBandDestination[];
      capsule: LockerBandCapsule;
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
    capsule: LOCKER_BAND_CAPSULE,
  };
}

// ─── The More sheet ─────────────────────────────────────────────────────────

/** Where a More row's act actually happens, from this seat. `here` is a route
 *  on this phone; `elsewhere` is a surface whose door is on another seat, and
 *  the row says which rather than offering a control with nothing behind it. */
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

/** The two surfaces this seat performs. Everything else in the sheet is a
 *  surface with an honest account of where it lives (SURFACES.md's seat
 *  column: Import and Export are custodian, Companion is the extension). */
const REACHED_HERE: ReadonlySet<LockerMoreRowKey> = new Set([
  "access",
  "trash",
]);

/** Rows keyed to the SHARED shelf ids, in the shared sheet's own order, with
 *  labels and meta taken from the shared table rather than respelled here. */
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

/** Exhaustive: a row without a route fails typecheck, not at tap. Every row
 *  leads somewhere — the three `elsewhere` surfaces share one screen that
 *  states what they are and where the act happens. */
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
