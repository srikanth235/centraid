// Every string a Docs view says about ITSELF: bar title, what the count counts,
// the caption closing a row set, how each shelf is empty on its own terms, the
// one mark a row may carry (§1.5, §2, §4.1, §4.3, §4.6). Here rather than in the
// orchestrator because it changes on its own schedule and "empty on its own
// terms" is a TABLE, not a chain of ternaries in a renderer.
//
// The spec's copy VERBATIM, with two departures and no others:
//   1. NUMBERS ARE REAL — the tables carry the NOUN, the caller the number.
//   2. THE STORAGE NOUN IS NEVER PRINTED FOR A SCOPE (#599): a member reads
//      `scope.label`, which the owner may rename.
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
  STARRED,
  STORAGE,
  TRASH,
  folderIdFrom,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

/** A verb's shape, from the app's one table. */
type ActionIcon = keyof typeof import("./icons.ts").ACTION_ICONS;

/** `unit` is plural; frame.tsx singularises it for a count of one. */
export interface ShelfCopy {
  title: string;
  unit: string;
}

/** §2's Title column and units. `Docs` where the spec leaves the app's own
 *  name — the meta line says which shelf. */
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

/** A folder's id is in no table: it carries the folder's name, which the
 *  caller supplies (§2 row 4). */
export function shelfCopy(id: ShelfId, folderName?: string): ShelfCopy {
  if (folderIdFrom(id)) {
    return { title: folderName ?? "Folder", unit: "documents" };
  }
  if (id === null) return ALL_COPY;
  return SHELF_COPY[id] ?? ALL_COPY;
}

/** Read by the breadcrumb and the More sheet, so neither restates a label. */
export const SHELF_LABELS: Readonly<Record<string, string>> = {
  [FOLDERS]: "Folders",
  [RECENT]: "Recently changed",
  [STARRED]: "Starred",
  [TRASH]: "Trash",
  [SEARCH]: "Search",
  [STORAGE]: "Storage",
};

// ─── Captions: the closing sentence under a row set (§4.1, §4.3) ─────

/** Never a sentence on a row: the caption carries the prose, once (§4.1) —
 *  which is why `rowStateMark` may return at most one mark. */
const CAPTION_ALL =
  "Everything here is on this gateway and on this device; a mark means this device only.";
const CAPTION_OFFLINE =
  "Titles, folders, filing and stars are read from this device; a row says what will not open.";
const CAPTION_RECENT =
  "Ordered by last change, newest first — a machine reading the contents counts as a change.";
const CAPTION_TRASH =
  "Each document is purged 30 days after deletion, on the date shown.";
const CAPTION_SEARCH =
  "318 documents could not be looked inside; they were matched on title and filing only.";

/**
 * `offline` wins over the shelf: a caption still promising "on this gateway"
 * while it is unreachable would be the one untrue sentence on screen.
 *
 * SEARCH'S CAPTION IS WITHHELD until the "what could not be searched" read
 * exists — the spec's sentence carries a count this app cannot yet ask for, and
 * naming it wrongly is worse than saying nothing.
 */
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
  if (id === SEARCH) {
    return searchUnreadable === undefined
      ? null
      : `${searchUnreadable} documents could not be looked inside; they were matched on title and filing only.`;
  }
  // A caller that does not know the name says "This folder" rather than
  // printing one it had to invent.
  if (folderIdFrom(id)) return folderCaption(folderName ?? "This folder");
  return CAPTION_ALL;
}

/** §4.3's folder caption, with the folder's real name. */
export function folderCaption(name: string): string {
  return `${name} is a label; taking it off does not delete anything.`;
}

/** For the day the unreadable count is real. */
export const SEARCH_CAPTION_SAMPLE = CAPTION_SEARCH;

// ─── The five empty states (§4.6) ─────

/**
 * Exactly FIVE distinguishable empty states — a new drive, an empty folder, an
 * empty shelf, a filter with no matches, a search with no matches — and only the
 * first is a whole-screen state with the display rung (§4.6).
 */
export type EmptyVariant = "drive" | "folder" | "shelf" | "filter" | "search";

export interface EmptyCopy {
  variant: EmptyVariant;
  /** Display serif ONLY for `drive`; every other variant takes the title rung. */
  display: boolean;
  title: string;
  body: string;
  /** Filled only on `drive`; elsewhere the app bar already holds the one
   *  filled control (§3.1). */
  action?: string;
  action2?: string;
  /** Word and mark kept together, never a component matching the display
   *  string — a copy edit would silently drop the mark. */
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

/** Empty because nothing was starred says something different from empty
 *  because the drive is new (§2's Note column). */
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
  [FOLDERS]: {
    variant: "shelf",
    display: false,
    title: "No folders yet",
    body: "A folder is a label on the document, not a place it sits.",
  },
};

/** A different thing to say from an empty drive — hence its own variant. */
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

/** The prototype's near-miss second sentence is NOT printed: this app cannot
 *  compute it. */
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

/** Distinct from a search miss because the way out differs: drop a pill, not
 *  the query. */
export const FILTER_EMPTY: EmptyCopy = {
  variant: "filter",
  display: false,
  title: "Nothing matches these filters",
  body: "Filters compose, so each one narrows what the last one left.",
  action: "Clear filters",
  actionIcon: "dismiss",
};

/** `query` and `filtered` are about what the member JUST DID, so they win — in
 *  that order, since a query is typed over a filter. */
export function emptyCopy(
  id: ShelfId,
  {
    query,
    filtered,
    folderName,
    driveIsEmpty,
  }: {
    query?: string;
    filtered?: boolean;
    folderName?: string;
    /** The one first-run state. */
    driveIsEmpty?: boolean;
  } = {}
): EmptyCopy {
  if (query) return searchEmpty(query);
  if (filtered) return FILTER_EMPTY;
  if (folderIdFrom(id)) return folderEmpty(folderName ?? "this folder");
  if (id === null && driveIsEmpty) return DRIVE_EMPTY;
  const shelf = typeof id === "string" ? SHELF_EMPTY[id] : undefined;
  return shelf ?? DRIVE_EMPTY;
}

// ─── The row state slot (§4.1) ─────

/**
 * The state slot shows AT MOST ONE thing, in this order (§4.1). A LADDER, not
 * independent conditions, and pure for exactly that reason: inline in a row
 * renderer three could be true at once and a row would carry three marks. The
 * last rung is a GLYPH, never a sentence.
 */
export interface RowStateInput {
  /** Beyond the fetched window; content has not arrived. */
  loadingBeyondWindow?: boolean;
  /** Came back FAILED, not still in flight — only then may a row claim it. */
  fetchFailed?: boolean;
  /** Docs cannot render this kind (§1.3). */
  cannotRender?: boolean;
  /** In Trash the slot carries the purge date instead. */
  inTrash?: boolean;
  /** Omitted keeps the slot blank rather than printing an uncomputed number. */
  purgeInDays?: number | null;
  /** The gateway is unreachable. */
  offline?: boolean;
  /** Under `offline` a row whose bytes are elsewhere opens to nothing, and
   *  says so. */
  bytesOnDevice?: boolean;
  /** The one custody state a member can lose something to. */
  deviceOnly?: boolean;
}

export interface RowStateMark {
  /** `glyph` renders the device mark with `text` as its accessible name. */
  kind: "text" | "glyph";
  text: string;
  /** The `net` role: a refusal, not a status. */
  net: boolean;
}

export function rowStateMark(input: RowStateInput): RowStateMark | null {
  // 1. Blank while still coming: only the failure is worth a word.
  if (input.loadingBeyondWindow) {
    return input.fetchFailed
      ? { kind: "text", text: "could not be fetched", net: true }
      : null;
  }
  // 2. No viewer to open, so the row says so before the member taps (§1.3).
  if (input.cannotRender && !input.inTrash) {
    return { kind: "text", text: "cannot be shown", net: false };
  }
  // 3. In trash the slot belongs to the purge date.
  if (input.inTrash) {
    return typeof input.purgeInDays === "number"
      ? {
          kind: "text",
          text: `purged in ${input.purgeInDays} ${input.purgeInDays === 1 ? "day" : "days"}`,
          net: false,
        }
      : null;
  }
  // 4. Offline with the bytes elsewhere: opening does nothing, so say so.
  if (input.offline && !input.bytesOnDevice) {
    return { kind: "text", text: "will not open", net: true };
  }
  // 5. A glyph, not a sentence — see the caption rule above.
  if (input.deviceOnly) {
    return { kind: "glyph", text: "on this device only", net: false };
  }
  return null;
}

// ─── The "More in Docs" sheet (§1.5) ─────

/** Its title and the sentence that closes it (§1.5). */
export const MORE_TITLE = "More in Docs";
export const MORE_FOOTER =
  "Everything Docs can show — the vault mark goes back to the rest of Centraid.";

/** `meta` is prose only where the prose is a RULE; where the spec printed a
 *  sample number the row carries none and the caller supplies the count. */
export interface MoreRow {
  /** `null` for a row that fires a verb. */
  shelf: ShelfId;
  label: string;
  meta?: string;
}

/**
 * `live` is what this app can honour today: an unrendered row is a dead end
 * avoided, the one thing a navigation surface may never be. The table stays
 * whole so landing a route flips one flag rather than re-deriving the copy.
 */
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
  // KIND AND SORT stays withheld, alone: it would restate the column heads and
  // filter pills the compact form factor already reaches — §1.5's "two menus".
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

// ─── Banners and status (§11) ─────

/** One sentence, one consequence, one action (DESIGN.md → Copy). The spec's
 *  queued-writes promise belongs where the write is made, not on every screen. */
export const OFFLINE_BANNER =
  "Gateway unreachable — filing works from this device, opening and search do not.";
export const OFFLINE_BANNER_ACTION = "Retry";

/** Recent is recently CHANGED, never recently opened (§14). */
export const RECENT_RULE =
  "Ordered by last change · nothing records when a document was opened";

/** "<label> · <n> document(s)", with Undo (§11). */
export function actionStatus(label: string, count: number): string {
  return `${label} · ${count} ${count === 1 ? "document" : "documents"}`;
}
