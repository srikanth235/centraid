// The phone's bottom band, as Docs claims it (Binding Layer v12 handoff,
// Part 2 §"The band"; issue #821).
//
// Docs claims the band with FIVE destinations — `All · Folders · Coming due ·
// Search · More` — which is the invariant's exact cap (five destinations, of
// which the fifth is More). More opens a SHEET, never a route: Docs has more
// shelves than slots, so the sixth onward live in the sheet rather than
// stealing a tab.
//
// The anatomy is Photos' anatomy, deliberately: two plates in a transparent
// row, the frame's 52pt Home capsule outside the tab group, the shared plate
// geometry from `kit/band-surface.ts`. The MODEL is restated here rather than
// imported from `apps/photos/photos-band.ts` because one app may not import
// another (`scripts/check-import-boundaries.ts`); what the two bands share
// structurally already lives in the kit.
//
// This module is deliberately free of `react-native` imports so the rules can
// be asserted directly (`docs-band.test.ts`). `DocsBand.tsx` renders them and
// adds nothing.

import {
  CAPABILITIES,
  NEWDOC,
  RECENT,
  STARRED,
  STORAGE,
  TRASH,
} from "@centraid/blueprints/apps/docs/shelves";
import { MORE_ROWS } from "@centraid/blueprints/apps/docs/view-copy";

import type { BandOwner } from "../../kit/band/band-owner";
import type { DocsStackParamList } from "../../navigation";

/** A destination in the claimed band. `more` opens the sheet, not a route.
 *  The other four are `DocsHome`'s own `destination` param — the frame's
 *  `navigation.ts` spells the same union longhand, and `DocsScreen.tsx`'s
 *  band handler pins the two together at its own typecheck. */
export type DocsBandDestinationKey =
  | "all"
  | "folders"
  | "due"
  | "search"
  | "more";

export interface DocsBandDestination {
  key: DocsBandDestinationKey;
  /** Copy is final (handoff Part 2 §"The band") — these five strings ARE the
   *  band. */
  label: string;
  icon: string;
}

/** The cap the frame's band lives under, and therefore the cap a claiming app
 *  lives under: five destinations, of which the fifth is More. Docs sits at
 *  the exact cap — deviation 1 of the handoff says so out loud. */
export const DOCS_BAND_MAX_DESTINATIONS = 5;

/** The frame capsule's width (the handoff's 52; height comes from the row's
 *  `align-items: stretch`, same as Photos). */
export const DOCS_BAND_CAPSULE_SIZE = 52;

/**
 * Docs' five, in the handoff's order. `due` is a band tab because tentative
 * obligations are work a member returns to; the shelves that are not
 * (Recently changed, Starred, Trash, Storage, capabilities, Add) live in the
 * More sheet.
 */
export const DOCS_BAND_DESTINATIONS: readonly DocsBandDestination[] = [
  { key: "all", label: "All", icon: "FileText" },
  { key: "folders", label: "Folders", icon: "Folder" },
  { key: "due", label: "Coming due", icon: "Clock" },
  { key: "search", label: "Search", icon: "Search" },
  { key: "more", label: "More", icon: "more-vertical" },
];

/** The frame's capsule — a frame control, never one of the app's tabs. */
export interface DocsBandCapsule {
  label: "Home";
  icon: "Home";
  size: number;
  edge: "leading";
  /** The seam. `false` is the whole reason it is not a sixth tab. */
  inTabGroup: false;
}

export const DOCS_BAND_CAPSULE: DocsBandCapsule = {
  label: "Home",
  icon: "Home",
  size: DOCS_BAND_CAPSULE_SIZE,
  edge: "leading",
  inTabGroup: false,
};

/** Exactly one band exists at any moment — same latch and same resolution
 *  rule as Photos (`kit/band/band-owner.ts`). */
export type ResolvedDocsBand =
  | {
      owner: "app";
      destinations: readonly DocsBandDestination[];
      capsule: DocsBandCapsule;
    }
  | { owner: "host" };

export function resolveDocsBand(owner: BandOwner): ResolvedDocsBand {
  if (owner === "host") return { owner: "host" };
  if (DOCS_BAND_DESTINATIONS.length > DOCS_BAND_MAX_DESTINATIONS) {
    throw new Error(
      `Docs claimed ${DOCS_BAND_DESTINATIONS.length} band destinations; the cap is ${DOCS_BAND_MAX_DESTINATIONS}`
    );
  }
  return {
    owner: "app",
    destinations: DOCS_BAND_DESTINATIONS,
    capsule: DOCS_BAND_CAPSULE,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The More sheet (handoff Part 2 §"The band": "The sheet lists: Recently
// changed, Starred, Trash, Storage, What Docs may read, Add to Docs.")
// ───────────────────────────────────────────────────────────────────────────

/** Every key the sheet carries — a closed union so `resolveDocsMoreRoute`
 *  switches exhaustively; a new row fails to typecheck before it can dangle. */
export type DocsMoreRowKey =
  | "recent"
  | "starred"
  | "trash"
  | "storage"
  | "capabilities"
  | "add";

export interface DocsMoreRow {
  key: DocsMoreRowKey;
  label: string;
  icon: string;
  /** The shared table's own meta prose where the prose is a rule; counts are
   *  interpolated at render time from live data, never stored here. */
  meta?: string;
}

/** The mobile sheet's six shelves, in the handoff's own order, keyed to the
 *  shared `MORE_ROWS` shelf ids so the LABELS and META stay the web app's
 *  words rather than a second spelling of them. */
const SHEET_SHELVES: readonly { key: DocsMoreRowKey; shelf: string }[] = [
  { key: "recent", shelf: RECENT },
  { key: "starred", shelf: STARRED },
  { key: "trash", shelf: TRASH },
  { key: "storage", shelf: STORAGE },
  { key: "capabilities", shelf: CAPABILITIES },
  { key: "add", shelf: NEWDOC },
];

const SHEET_ICONS: Readonly<Record<DocsMoreRowKey, string>> = {
  recent: "Clock",
  starred: "Star",
  trash: "Trash",
  storage: "Gauge",
  capabilities: "Eye",
  add: "Plus",
};

export const DOCS_MORE_ROWS: readonly DocsMoreRow[] = SHEET_SHELVES.map(
  ({ key, shelf }) => {
    const row = MORE_ROWS.find((candidate) => candidate.shelf === shelf);
    if (!row) throw new Error(`No shared More row for shelf ${shelf}`);
    return {
      key,
      label: row.label,
      icon: SHEET_ICONS[key],
      ...(row.meta ? { meta: row.meta } : {}),
    };
  }
);

/** The param-less Docs screens the sheet can reach. */
export type DocsMoreScreen = Extract<
  keyof DocsStackParamList,
  | "DocsRecent"
  | "DocsStarred"
  | "DocsTrash"
  | "DocsStorage"
  | "DocsCapabilities"
  | "DocsAdd"
>;

/** Where a More-sheet row goes — a pure, exhaustively-switched mapping so a
 *  row added to the sheet without a route fails to TYPECHECK, not at tap
 *  time (the same rule `photos-band.ts` learned from its silent fallthrough). */
export function resolveDocsMoreRoute(key: DocsMoreRowKey): DocsMoreScreen {
  switch (key) {
    case "recent":
      return "DocsRecent";
    case "starred":
      return "DocsStarred";
    case "trash":
      return "DocsTrash";
    case "storage":
      return "DocsStorage";
    case "capabilities":
      return "DocsCapabilities";
    case "add":
      return "DocsAdd";
    default: {
      const exhaustive: never = key;
      throw new Error(`Unhandled More-sheet row: ${String(exhaustive)}`);
    }
  }
}
