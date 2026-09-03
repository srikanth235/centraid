import { fmtDate } from "./format.ts";
import {
  CAPABILITIES,
  FILING,
  FOLDERS,
  LOCKER,
  NAMES,
  NEWDOC,
  RECENT,
  SCAN,
  SEARCH,
  SHARED,
  STARRED,
  STORAGE,
  TRASH,
  folderIdFrom,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

type ActionIcon = keyof typeof import("./icons.ts").ACTION_ICONS;

export interface ShelfCopy {
  title: string;
  unit: string;
}

const SHELF_COPY: Readonly<Record<string, ShelfCopy>> = {
  [FOLDERS]: { title: "Docs", unit: "folders" },
  [RECENT]: { title: "Docs", unit: "documents" },
  [STARRED]: { title: "Starred", unit: "documents" },
  [TRASH]: { title: "Docs", unit: "documents" },
  [SEARCH]: { title: "Search", unit: "results" },
  [STORAGE]: { title: "Storage", unit: "documents" },
  [NEWDOC]: { title: "Add to Docs", unit: "documents" },
  [SCAN]: { title: "Scan a document", unit: "pages" },
  [CAPABILITIES]: { title: "What Docs may read", unit: "capabilities" },
  [FILING]: { title: "Proposed filing", unit: "proposals" },
  [NAMES]: { title: "Who your documents name", unit: "people" },
  [LOCKER]: { title: "Docs and Locker", unit: "documents" },
};

const ALL_COPY: ShelfCopy = { title: "Docs", unit: "documents" };

export function shelfCopy(id: ShelfId, folderName?: string): ShelfCopy {
  if (folderIdFrom(id)) {
    return { title: folderName ?? "Folder", unit: "documents" };
  }
  if (id === null) return ALL_COPY;
  return SHELF_COPY[id] ?? ALL_COPY;
}

export const SHELF_LABELS: Readonly<Record<string, string>> = {
  [FOLDERS]: "Folders",
  [RECENT]: "Recently changed",
  [STARRED]: "Starred",
  [SHARED]: "Shared with you",
  [TRASH]: "Trash",
  [SEARCH]: "Search",
  [STORAGE]: "Storage",
};

const CAPTION_ALL =
  "Everything here is on this gateway and on this device; a mark means this device only.";
const CAPTION_OFFLINE =
  "Titles, folders, filing and stars are read from this device; a row says what will not open.";
const CAPTION_RECENT =
  "Ordered by last change, newest first — a machine reading the contents counts as a change.";
const CAPTION_TRASH =
  "Each document is purged 30 days after deletion, on the date shown.";
const CAPTION_SHARED = "Sorted by when it reached you, newest first.";

export const SHARED_SENDER_UNKNOWN = "Another vault";

export function sharedFromLine(from: {
  name: string | null;
  at: number;
}): string {
  const who = from.name ?? SHARED_SENDER_UNKNOWN;
  const when = from.at ? fmtDate(new Date(from.at).toISOString()) : "";
  return when ? `${who} · ${when}` : who;
}
const CAPTION_SEARCH =
  "318 documents could not be looked inside; they were matched on title and filing only.";

export function captionFor(
  id: ShelfId,
  {
    offline = false,
    searchUnreadable,
    folderName,
  }: {
    offline?: boolean;
    searchUnreadable?: number;
    folderName?: string;
  } = {}
): string | null {
  if (offline) return CAPTION_OFFLINE;
  if (id === TRASH) return CAPTION_TRASH;
  if (id === RECENT) return CAPTION_RECENT;
  if (id === SHARED) return CAPTION_SHARED;
  if (id === SEARCH) {
    return searchUnreadable === undefined
      ? null
      : `${searchUnreadable} documents could not be looked inside; they were matched on title and filing only.`;
  }
  if (folderIdFrom(id)) return folderCaption(folderName ?? "This folder");
  return CAPTION_ALL;
}

export function folderCaption(name: string): string {
  return `${name} is a label; taking it off does not delete anything.`;
}

export const SEARCH_CAPTION_SAMPLE = CAPTION_SEARCH;

export type EmptyVariant = "drive" | "folder" | "shelf" | "filter" | "search";

export interface EmptyCopy {
  variant: EmptyVariant;
  display: boolean;
  title: string;
  body: string;
  action?: string;
  action2?: string;
  actionIcon?: ActionIcon;
  action2Icon?: ActionIcon;
}

const DRIVE_EMPTY: EmptyCopy = {
  variant: "drive",
  display: true,
  title: "Nothing here yet",
  body: "Documents you bring in are held in this vault.",
  action: "Upload documents",
  actionIcon: "replace",
  action2: "Scan a document",
  action2Icon: "open",
};

const SHELF_EMPTY: Readonly<Record<string, EmptyCopy>> = {
  [RECENT]: {
    variant: "shelf",
    display: false,
    title: "Nothing has changed yet",
    body: "Nothing records when a document was opened, so the shelf orders by last change.",
  },
  [STARRED]: {
    variant: "shelf",
    display: false,
    title: "Nothing starred yet",
    body: "One star across Centraid — a photograph starred in Photos shows here.",
  },
  [TRASH]: {
    variant: "shelf",
    display: false,
    title: "Trash is empty",
    body: "Each document carries its own purge date.",
  },
  [SHARED]: {
    variant: "shelf",
    display: false,
    title: "Nothing has been shared with you yet",
    body: "When someone you are linked with shares a document, a copy lands here — and goes when they withdraw it.",
  },
  [FOLDERS]: {
    variant: "shelf",
    display: false,
    title: "No folders yet",
    body: "A folder is a label on the document, not a place it sits.",
  },
};

export function folderEmpty(name: string): EmptyCopy {
  return {
    variant: "folder",
    display: false,
    title: `Nothing is filed under ‘${name}’ yet`,
    body: "Anything moved here keeps its star, its tags and its history.",
    action: "Move documents here",
    actionIcon: "move",
    action2: "Delete this folder",
    action2Icon: "trash",
  };
}

export function searchEmpty(query: string): EmptyCopy {
  return {
    variant: "search",
    display: false,
    title: `Nothing matches ‘${query}’`,
    body: "Nothing in titles, contents, folders or tags.",
    action: "Clear the query",
    actionIcon: "dismiss",
  };
}

export const FILTER_EMPTY: EmptyCopy = {
  variant: "filter",
  display: false,
  title: "Nothing matches these filters",
  body: "Filters compose, so each one narrows what the last one left.",
  action: "Clear filters",
  actionIcon: "dismiss",
};

const SHARED_UNKNOWN: EmptyCopy = {
  variant: "shelf",
  display: false,
  title: "This seat cannot say what was shared",
  body: "Where each document came from is a separate read, and it did not answer.",
};

export function emptyCopy(
  id: ShelfId,
  {
    query,
    filtered,
    folderName,
    driveIsEmpty,
    sharedFromKnown = true,
  }: {
    query?: string;
    filtered?: boolean;
    folderName?: string;
    driveIsEmpty?: boolean;
    sharedFromKnown?: boolean;
  } = {}
): EmptyCopy {
  if (id === SHARED && !sharedFromKnown) return SHARED_UNKNOWN;
  if (query) return searchEmpty(query);
  if (filtered) return FILTER_EMPTY;
  if (folderIdFrom(id)) return folderEmpty(folderName ?? "this folder");
  if (id === null && driveIsEmpty) return DRIVE_EMPTY;
  const shelf = typeof id === "string" ? SHELF_EMPTY[id] : undefined;
  return shelf ?? DRIVE_EMPTY;
}

export interface RowStateInput {
  loadingBeyondWindow?: boolean;
  fetchFailed?: boolean;
  cannotRender?: boolean;
  inTrash?: boolean;
  purgeInDays?: number | null;
  offline?: boolean;
  bytesOnDevice?: boolean;
  deviceOnly?: boolean;
}

export interface RowStateMark {
  kind: "text" | "glyph";
  text: string;
  net: boolean;
}

export function rowStateMark(input: RowStateInput): RowStateMark | null {
  if (input.loadingBeyondWindow) {
    return input.fetchFailed
      ? { kind: "text", text: "could not be fetched", net: true }
      : null;
  }
  if (input.cannotRender && !input.inTrash) {
    return { kind: "text", text: "cannot be shown", net: false };
  }
  if (input.inTrash) {
    return typeof input.purgeInDays === "number"
      ? {
          kind: "text",
          text: `purged in ${input.purgeInDays} ${input.purgeInDays === 1 ? "day" : "days"}`,
          net: false,
        }
      : null;
  }
  if (input.offline && !input.bytesOnDevice) {
    return { kind: "text", text: "will not open", net: true };
  }
  if (input.deviceOnly) {
    return { kind: "glyph", text: "on this device only", net: false };
  }
  return null;
}

export const MORE_TITLE = "More in Docs";
export const MORE_FOOTER =
  "Everything Docs can show — the vault mark goes back to the rest of Centraid.";

export interface MoreRow {
  shelf: ShelfId;
  label: string;
  meta?: string;
}

export const MORE_ROWS: readonly (MoreRow & { live: boolean })[] = [
  { shelf: RECENT, label: "Recently changed", live: true },
  { shelf: STARRED, label: "Starred", meta: "shared", live: true },
  { shelf: TRASH, label: "Trash", meta: "purged in 30 days", live: true },
  { shelf: NEWDOC, label: "Add a document", meta: "the ways in", live: true },
  {
    shelf: SCAN,
    label: "Scan a document",
    meta: "how a scan arrives",
    live: true,
  },
  {
    shelf: CAPABILITIES,
    label: "What Docs may read",
    meta: "each a separate consent",
    live: true,
  },
  { shelf: FILING, label: "Proposed filing", meta: "off", live: true },
  { shelf: NAMES, label: "Who your documents name", meta: "off", live: true },
  {
    shelf: LOCKER,
    label: "Docs and Locker",
    meta: "where the line is",
    live: true,
  },
  {
    shelf: null,
    label: "Kind and sort",
    meta: "one sheet, not two menus",
    live: false,
  },
  {
    shelf: STORAGE,
    label: "Storage",
    meta: "what the drive weighs",
    live: true,
  },
];

export const OFFLINE_BANNER =
  "Gateway unreachable — filing works from this device, opening and search do not.";
export const OFFLINE_BANNER_ACTION = "Retry";

export const RECENT_RULE =
  "Ordered by last change · nothing records when a document was opened";

export function actionStatus(label: string, count: number): string {
  return `${label} · ${count} ${count === 1 ? "document" : "documents"}`;
}
