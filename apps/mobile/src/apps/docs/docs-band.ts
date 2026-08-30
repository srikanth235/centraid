// Docs' claim on the phone's bottom band (#821). Restated rather than imported
// from Photos' band: one app may not import another
// (`scripts/check-import-boundaries.ts`). No `react-native` here, so the rules
// stay assertable.

import {
  CAPABILITIES,
  NEWDOC,
  RECENT,
  STARRED,
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
  | "due"
  | "search"
  | "more";

export interface DocsBandDestination {
  key: DocsBandDestinationKey;
  label: string;
  icon: string;
}

export const DOCS_BAND_MAX_DESTINATIONS = 5;

export const DOCS_BAND_DESTINATIONS: readonly DocsBandDestination[] = [
  { key: "all", label: "All", icon: "FileText" },
  { key: "folders", label: "Folders", icon: "Folder" },
  { key: "due", label: "Coming due", icon: "Clock" },
  { key: "search", label: "Search", icon: "Search" },
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
  meta?: string;
}

/** From `MORE_ROWS`, never respelled here. */
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

export type DocsMoreScreen = Extract<
  keyof DocsStackParamList,
  | "DocsRecent"
  | "DocsStarred"
  | "DocsTrash"
  | "DocsStorage"
  | "DocsCapabilities"
  | "DocsAdd"
>;

/** Exhaustive: a row without a route fails typecheck, not at tap. */
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
