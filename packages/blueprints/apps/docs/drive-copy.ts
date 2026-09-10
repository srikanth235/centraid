// What a DRIVE SCREEN says beyond its row set (§1.6, §4.1–4.3): crumb chain,
// filter row, trash's ask, the fetched window's one refusal.
//
// A second copy module on purpose. `view-copy.ts` answers "what is this SHELF";
// this answers "what does the screen around those rows say" — a different
// schedule, a different set of readers.
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

// ─── The sort menu (§4.1) ─────

/**
 * THE MENU IS NOT A SECOND SORT CONTROL, it is the column heads said in
 * sentences: pressing a head twice to reverse it is invisible until you know it,
 * so this names the directions. Every entry resolves to a (key, direction) pair
 * the heads also produce, so the two can never disagree.
 */
export const SORT_OPTIONS: readonly SortOption[] = [
  { key: "changed", dir: -1, name: "Date changed", sub: "newest first" },
  { key: "changed", dir: 1, name: "Date changed", sub: "oldest first" },
  { key: "name", dir: 1, name: "Name", sub: "A to Z" },
  { key: "kind", dir: 1, name: "Kind", sub: "A to Z" },
  { key: "size", dir: -1, name: "Size", sub: "largest first" },
];

// ─── The breadcrumb (§1.6) ─────

/** The TRAILING crumb has no `shelf`: it owns the place and carries its menu;
 *  every crumb before it is a link and nothing else (§1.6). */
export interface Crumb {
  label: string;
  /** Where this crumb goes. Absent on the trailing crumb: it is where you are. */
  shelf?: ShelfId;
}

/** The app's own name, first crumb of every chain. */
const ROOT_CRUMB: Crumb = { label: "Docs", shelf: null };

/** A folder's chain goes THROUGH Folders, the same fact `stripShelf` and
 *  `bandActiveId` encode, so the three surfaces agree where a folder sits. */
export function crumbsFor(
  id: ShelfId,
  {
    folderName,
    searching = false,
    title,
    tail,
  }: {
    folderName?: string;
    /** A live query is its own place, whatever shelf it was typed over. */
    searching?: boolean;
    /** A document's own title, for the chains that end inside one document. */
    title?: string;
    /** The trailing crumb for a screen under a document (§1.6's `History`). */
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

/**
 * THE POINTER SURFACE'S ONLY DOOR to the seven off-strip destinations: the strip
 * holds five tabs, the compact band reaches the rest through More, and at a desk
 * there is no More sheet. Lives HERE, not in a route, because more than one
 * route draws the breadcrumb — a door on some screens and not others is not a
 * door (§1.6).
 */
export interface PlaceMenuItem {
  label: string;
  shelf: ShelfId;
  /** Every row has one: a menu where some rows carry a glyph and others a gap
   *  reads as a menu with something missing. */
  icon: keyof typeof PLACE_ICONS;
  /** The menu is three answers to three questions, not one list of seven, so a
   *  member can stop reading once they are in the right group. */
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

// ─── The filter row (§4.2) ─────

/**
 * §4.2's four properties. `live` is an honesty flag: an axis renders only where
 * THIS DRIVE can answer it from what it actually read, since a pill whose
 * options cannot be computed either does nothing or filters by an invented fact.
 *
 * PEOPLE IS LIT ON ONE HALF OF ITSELF (#821): `shared_with` makes "shared with
 * <somebody>" computable, and its options are DERIVED FROM THE ROWS
 * (filters.ts `liveOptions`) because the audiences change with the vault. The
 * OWNER and NAMES halves stay dark and unlisted — this drive projects one vault
 * and reads no mentioned names.
 */
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
    // Empty on purpose: every option is an audience the rows actually name.
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

/** The option string IS the filter value, so the predicate compares generated
 *  strings rather than parsing a label back out. */
export function sharedWithOption(label: string): string {
  return `Shared with ${label}`;
}

/** §4.2's link, which appears only once at least one filter is set. */
export const CLEAR_FILTERS = "Clear filters";

// ─── The Search shelf's field ─────

/** Names the TWO things this search reaches — the promise the shelf must keep,
 *  and deliberately not a people axis this drive does not have. */
export const SEARCH_PLACEHOLDER = "Search titles and contents";

/** The placeholder is NOT a name: it disappears the moment a member types, and
 *  a control that loses its name mid-use cannot be re-read. */
export const SEARCH_LABEL = "Search documents by title or contents";

/** A WORD beside the field, not an icon button. Same word Photos uses. */
export const SEARCH_CLEAR = "Clear";

/**
 * Seat-honest (docs/blueprint-seats.md): `queries/search.ts` runs FTS5 over the
 * gateway's own index with no replica in the path, so "the live library" is
 * literal. Mobile searches a replica, owes a different sentence, and does not
 * read this constant.
 */
export const SEARCH_SCOPE = "the live library";

/** Literal: a member can type any of these back and this drive will answer. */
export const SEARCH_EXAMPLES: readonly string[] = [
  "right of way",
  "lease expiry",
  "anything from the solicitor",
  "scans with no folder",
  "xlsx over 1 MB",
];

/**
 * The four states, in the product's own words; this file is the only place that
 * says them. ONE HANDOFF SENTENCE IS DELIBERATELY NOT COPIED — its near-miss
 * claim would need an edit-distance pass nobody has run, and printing it would
 * be the screen inventing a fact.
 */
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

// ─── Emptying the trash (§4.3, §14; #1015 D1) ─────

/**
 * THE VERB, AT LAST. This used to be an ask — "Delete forever and Empty trash,
 * not available yet" — because no vault command could bring a purge date
 * forward. `core.empty_document_trash` is that command (#1015, D1), so Docs
 * answers the question Photos already answered, in the same words.
 *
 * The control never destroys: it opens the confirm, and the confirm says how
 * many, that it is final, and that restore will not bring them back. Outlined
 * `--net`, never filled — an irreversible control must not look louder than
 * Upload (DESIGN.md → Components).
 */
export const TRASH_NOTE =
  "Documents in the trash purge on their own schedule; restoring one puts its folder and its star back.";

export const EMPTY_TRASH_COPY = {
  control: "Empty trash",
  /** The noun rides the control, so a member reads WHAT goes (DESIGN.md → Copy). */
  label: (count: number) =>
    `Empty trash — ${count} ${count === 1 ? "document" : "documents"}`,
  question: (count: number) =>
    `Delete ${count} ${count === 1 ? "document" : "documents"} forever?`,
  detail: (count: number) =>
    `This cannot be undone. ${count === 1 ? "It leaves" : "They leave"} the vault now, with every earlier version, and restore will not bring ${count === 1 ? "it" : "them"} back.`,
  confirm: (count: number) => `Delete ${count} forever`,
  cancel: "Keep them",
  /** What the shelf says after the write lands (StatusLine, never a toast). */
  done: (count: number) =>
    `Trash emptied — ${count} ${count === 1 ? "document" : "documents"} · receipted.`,
  empty: "Trash is empty.",
} as const;

// ─── The fetched window (§4.1 state slot rung 1) ─────

/** The ONLY thing rung 1 ever says: a window still in flight says nothing. */
export const WINDOW_FAILED = "could not be fetched";

// ─── The Folders shelf (§4.3) ─────

/**
 * Never a sentence on a row: the caption under the set carries the prose, once
 * (§4.1). The Unfiled row keeps the number; its sentence lives here, or the
 * column would mean two different things depending on which row you read.
 */
export function foldersCaption(unfiled: number): string {
  const those =
    unfiled === 1 ? "one document was" : `${unfiled} documents were`;
  return unfiled === 0
    ? "A folder is a label on the document, not a place it sits."
    : `A folder is a label on the document, not a place it sits. Unfiled is not a folder — ${those} never given one, which is not an error.`;
}
