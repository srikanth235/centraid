// Every string a Docs view says about ITSELF: the app-bar title, what the
// count counts, the caption that closes a row set, how each shelf is empty on
// its own terms, and the one mark a row is allowed to carry (Docs spec §1.5,
// §2, §4.1, §4.3, §4.6).
//
// Extracted from the orchestrator for the same two reasons Photos extracted
// its own: copy is a product decision that changes on its own schedule, and
// "each shelf is empty on its own terms" is a TABLE, not a chain of ternaries
// in a render function.
//
// The copy here is the spec's, VERBATIM, with two documented classes of
// departure and no others:
//
//   1. NUMBERS ARE REAL. The spec's screen index prints the prototype's sample
//      drive ("1,908 · in this vault", "Trash · 9"). Those are sample data;
//      what ships is the member's own count, so the tables here carry the
//      NOUN and the caller supplies the number.
//   2. THE STORAGE NOUN IS NEVER PRINTED FOR A SCOPE (issue #599). What a
//      member reads for a scope is `scope.label`, which the owner may rename.
//      Where the spec writes "this vault" as a place-name it is left as the
//      spec's own words about the drive, never interpolated with a scope.
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

/** A verb's shape, by name, from the app's one table. */
type ActionIcon = keyof typeof import("./icons.ts").ACTION_ICONS;

/** What a shelf calls itself in the frame's app bar, and what its count
 *  counts. `unit` is plural; frame.tsx singularises it for a count of one. */
export interface ShelfCopy {
  title: string;
  unit: string;
}

/** §2's Title column, with §2's own units. `Docs` is the title on every shelf
 *  the spec leaves as the app's own name — the meta line says which shelf. */
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

/**
 * The bar's title and unit for a shelf. A folder's own id is in no table — a
 * folder carries the folder's name, which the caller supplies (§2 row 4:
 * title "Property", meta "38 · folder").
 */
export function shelfCopy(id: ShelfId, folderName?: string): ShelfCopy {
  if (folderIdFrom(id)) {
    return { title: folderName ?? "Folder", unit: "documents" };
  }
  if (id === null) return ALL_COPY;
  return SHELF_COPY[id] ?? ALL_COPY;
}

/** The strip/band tab a shelf lights, in the words a member reads — used by
 *  the breadcrumb and the More sheet so neither restates the label. */
export const SHELF_LABELS: Readonly<Record<string, string>> = {
  [FOLDERS]: "Folders",
  [RECENT]: "Recently changed",
  [STARRED]: "Starred",
  [TRASH]: "Trash",
  [SEARCH]: "Search",
  [STORAGE]: "Storage",
};

// ───────────────────────────────────────────────────────────────────────────
// Captions — the closing sentence under a row set (§4.1, §4.3)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The caption is where the PROSE lives, once. "Never a sentence on a row: the
 * caption under the set carries the prose, once." (spec §4.1, verbatim).
 * That is the whole reason `rowStateMark` below may return at most one mark:
 * everything else the set has to say, it says here.
 */
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
 * The caption for the current row set. `offline` wins over the shelf, because
 * a caption that still promised "on this gateway and on this device" while the
 * gateway was unreachable would be the one sentence on screen that was untrue.
 *
 * SEARCH'S CAPTION IS WITHHELD until the "what could not be searched" read
 * exists: the spec's sentence carries a count of documents nobody could look
 * inside, and this app cannot yet ask that question. Naming the count wrongly
 * is worse than saying nothing, so it says nothing (`searchUnreadable`
 * supplies the number the day the read lands).
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
  // §4.3's folder caption puts the folder's own name in the subject slot. A
  // caller that does not know the name says "This folder" rather than
  // printing one it had to invent.
  if (folderIdFrom(id)) return folderCaption(folderName ?? "This folder");
  return CAPTION_ALL;
}

/** §4.3's folder caption, with the folder's real name in the subject slot. */
export function folderCaption(name: string): string {
  return `${name} is a label; taking it off does not delete anything.`;
}

/** The spec's own search caption, for the day the unreadable count is real. */
export const SEARCH_CAPTION_SAMPLE = CAPTION_SEARCH;

// ───────────────────────────────────────────────────────────────────────────
// The five empty states (§4.6)
// ───────────────────────────────────────────────────────────────────────────

/**
 * "Five empty states: a new drive (this one), an empty folder, an empty shelf,
 * a filter with no matches, a search with no matches. Only this one gets a
 * display serif." (§4.6 `noteBlock`, verbatim.)
 *
 * That note is not decoration — it is the model. There are exactly five, they
 * are distinguishable, and only the first is a whole-screen state with the
 * display rung. Everything else is one state of a normally-populated screen.
 */
export type EmptyVariant = "drive" | "folder" | "shelf" | "filter" | "search";

export interface EmptyCopy {
  variant: EmptyVariant;
  /** Display serif ONLY for `drive` (§4.6). Every other variant takes the
   *  title rung, because it is one state of a screen that normally has rows. */
  display: boolean;
  title: string;
  body: string;
  /** The primary way forward. Filled only on `drive`; elsewhere the view's one
   *  filled control already lives in the app bar (§3.1 `emptyBlock`). */
  action?: string;
  action2?: string;
  /** Each way forward's SHAPE, from the app's one verb table (`icons.ts`
   *  `ACTION_ICONS`). The word and the mark are kept in one place, together,
   *  rather than a component looking a glyph up by matching the display
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

/** How each shelf is empty ON ITS OWN TERMS (§2's Note column, verbatim). A
 *  shelf that is empty because nothing has been starred says something
 *  different from one that is empty because the drive is new. */
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

/** §4.3's empty-folder panel — "a different thing to say from an empty
 *  drive", which is exactly why it is its own variant. */
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

/** §4.3's no-results panel. The prototype's second sentence names a specific
 *  near-miss in its sample drive ("One letter short of a phrase in two of your
 *  documents"), which this app cannot compute, so it is not printed. */
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

/** The fourth variant: filters that compose down to nothing. Distinct from a
 *  search miss because the way out is different — drop a pill, not the query
 *  (§4.2's own "Clear filters" link is the action). */
export const FILTER_EMPTY: EmptyCopy = {
  variant: "filter",
  display: false,
  title: "Nothing matches these filters",
  body: "Filters compose, so each one narrows what the last one left.",
  action: "Clear filters",
  actionIcon: "dismiss",
};

/**
 * The empty copy for a view, or the first-run drive state. `query` and
 * `filtered` are about what the member JUST DID rather than about the shelf,
 * so they win — in that order, since a query is typed over a filter.
 */
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
    /** The whole drive has nothing in it — the one first-run state. */
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

// ───────────────────────────────────────────────────────────────────────────
// The row state slot (§4.1)
// ───────────────────────────────────────────────────────────────────────────

/**
 * "The state slot shows AT MOST ONE thing, in this order." (§4.1, verbatim
 * comment at prototype line 3781.)
 *
 * This is a LADDER, not a set of independent conditions, and it is a pure
 * function for exactly that reason: expressed inline in a row renderer, three
 * of these could be true at once and a row would carry three marks — which is
 * how "on this device only" ended up sitting next to "will not open" in the
 * prototype's own first draft.
 *
 * The last rung is a GLYPH, never a sentence: "Never a sentence on a row: the
 * caption under the set carries the prose, once." (§4.1, verbatim.)
 */
export interface RowStateInput {
  /** This row is beyond the fetched window and its content has not arrived. */
  loadingBeyondWindow?: boolean;
  /** The fetch for this row came back failed, rather than still being in
   *  flight. Only then may a row claim it could not be fetched. */
  fetchFailed?: boolean;
  /** Docs cannot render this kind (Word, Spreadsheet, Deck) — §1.3. */
  cannotRender?: boolean;
  /** The row sits in Trash, where the slot carries the purge date instead. */
  inTrash?: boolean;
  /** Days until this document purges. Omitted keeps the slot blank rather
   *  than printing a number nobody computed. */
  purgeInDays?: number | null;
  /** The gateway is unreachable (view-state.ts `libraryReachability`). */
  offline?: boolean;
  /** The bytes are on this device. Under `offline`, a row whose bytes are not
   *  here would do nothing when opened, and says so. */
  bytesOnDevice?: boolean;
  /** Held on this device and nowhere else — the one custody state a member
   *  can lose something to. */
  deviceOnly?: boolean;
}

export interface RowStateMark {
  /** `text` renders in the slot; `glyph` renders the device mark with `text`
   *  as its accessible name and nothing visible. */
  kind: "text" | "glyph";
  text: string;
  /** Drawn in the `net` role — a refusal, not a status. */
  net: boolean;
}

export function rowStateMark(input: RowStateInput): RowStateMark | null {
  // 1. Beyond the fetched window. Blank while it is still coming; the failure
  //    is the only thing worth a word, and it is a refusal.
  if (input.loadingBeyondWindow) {
    return input.fetchFailed
      ? { kind: "text", text: "could not be fetched", net: true }
      : null;
  }
  // 2. A kind Docs cannot render has no viewer to open — the rail is the
  //    answer for it (§1.3), and the row says so before the member taps.
  if (input.cannotRender && !input.inTrash) {
    return { kind: "text", text: "cannot be shown", net: false };
  }
  // 3. In trash the slot belongs to the purge date. Every other state is a
  //    fact about a document that is on its way out anyway.
  if (input.inTrash) {
    return typeof input.purgeInDays === "number"
      ? {
          kind: "text",
          text: `purged in ${input.purgeInDays} ${input.purgeInDays === 1 ? "day" : "days"}`,
          net: false,
        }
      : null;
  }
  // 4. Offline and the bytes are elsewhere: opening this row would do
  //    nothing, so the row says so rather than letting the member find out.
  if (input.offline && !input.bytesOnDevice) {
    return { kind: "text", text: "will not open", net: true };
  }
  // 5. The device mark. A glyph, not a sentence — see the caption rule above.
  if (input.deviceOnly) {
    return { kind: "glyph", text: "on this device only", net: false };
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// The "More in Docs" sheet (§1.5)
// ───────────────────────────────────────────────────────────────────────────

/** The sheet's own title and the sentence that closes it (§1.5, verbatim). */
export const MORE_TITLE = "More in Docs";
export const MORE_FOOTER =
  "Everything Docs can show — the vault mark goes back to the rest of Centraid.";

/**
 * One row of §1.5's table. `meta` is the spec's own prose where the prose is a
 * rule ("four ways in", "one sheet, not two menus"); where the spec printed a
 * sample number the row carries no meta and the caller supplies the real count.
 */
export interface MoreRow {
  /** The shelf this row reaches, or `null` for a row that fires a verb. */
  shelf: ShelfId;
  label: string;
  meta?: string;
}

/**
 * §1.5's eight rows, in the spec's order and with the spec's words.
 *
 * `live` is what THIS WAVE can honour. A row whose destination does not exist
 * yet is not rendered: a sheet that offers a place the app cannot reach is a
 * dead end, which is the one thing a navigation surface may never be. The
 * table stays whole so the agent who lands each route flips one flag rather
 * than re-deriving the copy.
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
  // KIND AND SORT stays withheld, and it is the only row that does. The sheet
  // would be a compact restatement of the column heads and the filter pills,
  // both of which the compact form factor already reaches — the sort through
  // its own button, the filters through their own row. A second surface over
  // the same two controls is what §1.5 calls "two menus", said once.
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

// ───────────────────────────────────────────────────────────────────────────
// Banners and status (§11)
// ───────────────────────────────────────────────────────────────────────────

/** §11's offline banner, compressed to the banner budget (DESIGN.md → Copy):
 *  one sentence, the state plus its one consequence, and one action. The
 *  spec's paragraph also promised that queued writes survive; that promise
 *  belongs where the write is made, not on every screen. */
export const OFFLINE_BANNER =
  "Gateway unreachable — filing works from this device, opening and search do not.";
export const OFFLINE_BANNER_ACTION = "Retry";

/** §2 row 5's rule, said once where the shelf is: Recent is recently
 *  CHANGED, never recently opened (§14's binding rationale). */
export const RECENT_RULE =
  "Ordered by last change · nothing records when a document was opened";

/** §11's action status line: "<label> · <n> document(s)", with Undo. */
export function actionStatus(label: string, count: number): string {
  return `${label} · ${count} ${count === 1 ? "document" : "documents"}`;
}
