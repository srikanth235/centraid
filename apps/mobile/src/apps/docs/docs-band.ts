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

const DUE_ROW: DocsMoreRow = {
  key: "due",
  label: "Coming due",
  icon: "Clock",
  meta: "off",
};

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
