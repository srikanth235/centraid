import type { SearchStateCopy } from "../_shared/search-scaffold.ts";
import type { PLACE_ICONS } from "./icons.ts";
import {
  CAPABILITIES,
  FILING,
  FOLDERS,
  LOCKER,
  NAMES,
  NEWDOC,
  SCAN,
  STORAGE,
  folderIdFrom,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type { SortOption } from "./types.ts";
import { SHELF_LABELS } from "./view-copy.ts";

export const SORT_OPTIONS: readonly SortOption[] = [
  { key: "changed", dir: -1, name: "Date changed", sub: "newest first" },
  { key: "changed", dir: 1, name: "Date changed", sub: "oldest first" },
  { key: "name", dir: 1, name: "Name", sub: "A to Z" },
  { key: "kind", dir: 1, name: "Kind", sub: "A to Z" },
  { key: "size", dir: -1, name: "Size", sub: "largest first" },
];

export interface Crumb {
  label: string;
  shelf?: ShelfId;
}

const ROOT_CRUMB: Crumb = { label: "Docs", shelf: null };

export function crumbsFor(
  id: ShelfId,
  {
    folderName,
    searching = false,
    title,
    tail,
  }: {
    folderName?: string;
    searching?: boolean;
    title?: string;
    tail?: string;
  } = {}
): readonly Crumb[] {
  if (title) {
    return tail
      ? [ROOT_CRUMB, { label: title }, { label: tail }]
      : [ROOT_CRUMB, { label: title }];
  }
  if (searching) return [ROOT_CRUMB, { label: "Search" }];
  const folderId = folderIdFrom(id);
  if (folderId) {
    return [
      ROOT_CRUMB,
      { label: "Folders", shelf: FOLDERS },
      { label: folderName ?? "Folder" },
    ];
  }
  if (id === null) return [ROOT_CRUMB, { label: "All documents" }];
  return [ROOT_CRUMB, { label: SHELF_LABELS[id] ?? "All documents" }];
}

export interface PlaceMenuItem {
  label: string;
  shelf: ShelfId;
  icon: keyof typeof PLACE_ICONS;
  group?: boolean;
}

export const PLACE_MENU: readonly PlaceMenuItem[] = [
  { label: "Add a document", shelf: NEWDOC, icon: "newdoc" },
  { label: "Scan a document", shelf: SCAN, icon: "scan" },
  { label: "Storage", shelf: STORAGE, icon: "storage", group: true },
  {
    label: "What Docs may read",
    shelf: CAPABILITIES,
    icon: "capabilities",
    group: true,
  },
  { label: "Proposed filing", shelf: FILING, icon: "filing" },
  { label: "Who your documents name", shelf: NAMES, icon: "names" },
  { label: "Docs and Locker", shelf: LOCKER, icon: "locker" },
];

export interface FilterAxis {
  id: "type" | "people" | "modified" | "source";
  label: string;
  options: readonly string[];
  live: boolean;
}

export const DFILTERS: readonly FilterAxis[] = [
  {
    id: "type",
    label: "Type",
    options: [
      "PDF",
      "Image",
      "Word",
      "Spreadsheet",
      "Markdown",
      "Text",
      "Audio",
      "Video",
      "Folder",
    ],
    live: true,
  },
  {
    id: "people",
    label: "People",
    options: [],
    live: true,
  },
  {
    id: "modified",
    label: "Modified",
    options: [
      "Today",
      "Last 7 days",
      "Last 30 days",
      "This year",
      "Before 2026",
    ],
    live: true,
  },
  {
    id: "source",
    label: "Source",
    options: [
      "On this device",
      "Gateway only",
      "Scanned here",
      "From the share sheet",
      "In the backup",
    ],
    live: true,
  },
];

export function sharedWithOption(label: string): string {
  return `Shared with ${label}`;
}

export const CLEAR_FILTERS = "Clear filters";

export const SEARCH_PLACEHOLDER = "Search titles and contents";

export const SEARCH_LABEL = "Search documents by title or contents";

export const SEARCH_CLEAR = "Clear";

export const SEARCH_SCOPE = "the live library";

export const SEARCH_EXAMPLES: readonly string[] = [
  "right of way",
  "lease expiry",
  "anything from the solicitor",
  "scans with no folder",
  "xlsx over 1 MB",
];

export const SEARCH_COPY = {
  resting: {
    eyebrow: "Nothing typed",
    title: "Search titles and contents, across the whole library",
    body: "Not the page that happens to be loaded — try one of these.",
  },
  searching: {
    lead: "Searching titles and contents.",
    trail: (count: number): string =>
      count === 1
        ? "match so far, from what is already loaded."
        : "matches so far, from what is already loaded.",
  },
  miss: {
    eyebrow: "No results",
    title: (query: string): string => `Nothing matches \u201C${query}\u201D`,
    body: "Nothing in titles, contents, folders or tags.",
    clear: "Clear the query",
  },
  unreachable: {
    eyebrow: "Cannot reach the gateway",
    title: "Search needs the library",
    body: "Search asks the live library, which is unreachable here. The drive still lists what this device holds; search will not pretend to have looked.",
    facts: [
      {
        label: "what still works",
        value: "browsing, folders, filing, starred",
      },
      { label: "what does not", value: "search, on this surface only" },
    ],
    retry: "Retry",
  },
} as const satisfies SearchStateCopy;

export const TRASH_ASK = {
  eyebrow: "Not available yet",
  title: "Delete forever and Empty trash",
} as const;

export const TRASH_FALLBACK =
  "Destruction happens only on the schedule a purge date announces, so a trash cannot be emptied.";

export const WINDOW_FAILED = "could not be fetched";

export function foldersCaption(unfiled: number): string {
  const those =
    unfiled === 1 ? "one document was" : `${unfiled} documents were`;
  return unfiled === 0
    ? "A folder is a label on the document, not a place it sits."
    : `A folder is a label on the document, not a place it sits. Unfiled is not a folder — ${those} never given one, which is not an error.`;
}
