// Docs' claim on the phone's bottom band (#821). Restated rather than imported
// from Photos' band: one app may not import another
// (`scripts/check-import-boundaries.ts`). No `react-native` here, so the rules
// stay assertable.

import {
  CAPABILITIES,
  NEWDOC,
  RECENT,
  STORAGE,
  TRASH,
} from "@centraid/blueprints/apps/docs/shelves";
import { MORE_ROWS } from "@centraid/blueprints/apps/docs/view-copy";

import { BAND_CAPSULE } from "../../kit/band/band-capsule";
import type { BandCapsule } from "../../kit/band/band-capsule";
import type { BandOwner } from "../../kit/band/band-owner";
import type { DocsStackParamList } from "../../navigation";

// The frame's capsule lives in `kit/band/band-capsule.ts` (#883 B5); only the
// TYPE is re-exported here.
export type { BandCapsule } from "../../kit/band/band-capsule";

export type DocsBandDestinationKey =
  | "all"
  | "folders"
  | "starred"
  | "shared"
  | "due"
  | "search"
  | "more";

export interface DocsBandDestination {
  key: DocsBandDestinationKey;
  label: string;
  icon: string;
}

export const DOCS_BAND_MAX_DESTINATIONS = 5;

// The shared table (`blueprints/apps/docs/shelves.ts` BAND_DESTINATIONS) names
// three: All, Folders, Search. Starred takes the slot the handoff gave its
// `Coming due` — that one truncated to "Coming d…" at every width and keeps
// its full name on the More sheet, and the star is the one mark a member sets
// by hand. Starred is off that sheet for it: one shelf, one door. Phone-only;
// docs/design-divergences.md carries the rest.
//
// SEARCH GAVE UP THE FOURTH SLOT TO SHARED. A band slot is for a place you
// RETURN to, and the two differ on exactly that: search is a verb you perform
// and leave, while what other people sent you is a standing set that grows
// without you touching it — and had no door at all before, which is the worse
// failure. Search keeps its full screen and its shortcut; it is reached from
// More, at the top, ahead of every other row there.
export const DOCS_BAND_DESTINATIONS: readonly DocsBandDestination[] = [
  { key: "all", label: "All", icon: "FileText" },
  { key: "folders", label: "Folders", icon: "Folder" },
  { key: "starred", label: "Starred", icon: "Star" },
  { key: "shared", label: "Shared", icon: "users" },
  { key: "more", label: "More", icon: "more-vertical" },
];

export type ResolvedDocsBand =
  | {
      owner: "app";
      destinations: readonly DocsBandDestination[];
      capsule: BandCapsule;
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
    capsule: BAND_CAPSULE,
  };
}

export type DocsMoreRowKey =
  | "search"
  | "due"
  | "recent"
  | "trash"
  | "storage"
  | "capabilities"
  | "add";

export interface DocsMoreRow {
  key: DocsMoreRowKey;
  label: string;
  icon: string;
  meta?: string;
}

/** From `MORE_ROWS`, never respelled here. */
const SHEET_SHELVES: readonly {
  key: Exclude<DocsMoreRowKey, "due" | "search">;
  shelf: string;
}[] = [
  { key: "recent", shelf: RECENT },
  { key: "trash", shelf: TRASH },
  { key: "storage", shelf: STORAGE },
  { key: "capabilities", shelf: CAPABILITIES },
  { key: "add", shelf: NEWDOC },
];

const SHEET_ICONS: Readonly<
  Record<Exclude<DocsMoreRowKey, "due" | "search">, string>
> = {
  recent: "Clock",
  trash: "Trash",
  storage: "Gauge",
  capabilities: "Eye",
  add: "Plus",
};

/** Coming due has no shelf in the shared table — it is a phone destination,
 *  not a web one — so its row is spelled here rather than looked up. */
const DUE_ROW: DocsMoreRow = {
  key: "due",
  label: "Coming due",
  icon: "Clock",
  meta: "off",
};

/** The band slot Shared took. First row, because it is the one people come to
 *  this sheet FOR — and, like `due`, a `DocsHome` destination rather than a
 *  pushed screen, so it is spelled here and not looked up as a shelf route. */
const SEARCH_ROW: DocsMoreRow = {
  key: "search",
  label: "Search",
  icon: "Search",
  meta: "titles only",
};

export const DOCS_MORE_ROWS: readonly (DocsMoreRow & {
  key: Exclude<DocsMoreRowKey, "due" | "search">;
})[] = SHEET_SHELVES.map(({ key, shelf }) => {
  const row = MORE_ROWS.find((candidate) => candidate.shelf === shelf);
  if (!row) throw new Error(`No shared More row for shelf ${shelf}`);
  return {
    key,
    label: row.label,
    icon: SHEET_ICONS[key],
    ...(row.meta ? { meta: row.meta } : {}),
  };
});

export const DOCS_MORE_SHEET_ROWS: readonly DocsMoreRow[] = [
  SEARCH_ROW,
  DUE_ROW,
  ...DOCS_MORE_ROWS,
];

export type DocsMoreScreen = Extract<
  keyof DocsStackParamList,
  "DocsRecent" | "DocsTrash" | "DocsStorage" | "DocsCapabilities" | "DocsAdd"
>;

/** Exhaustive: a row without a route fails typecheck, not at tap. `due` and
 *  `search` are excluded because both are DESTINATIONS on `DocsHome`, not
 *  pushed screens — and Starred is not a row here at all, having taken a band
 *  slot, as Shared now has. */
export function resolveDocsMoreRoute(
  key: Exclude<DocsMoreRowKey, "due" | "search">
): DocsMoreScreen {
  switch (key) {
    case "recent":
      return "DocsRecent";
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
