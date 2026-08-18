// What a DRIVE SCREEN says about itself beyond its row set (Docs spec §1.6,
// §4.1, §4.2, §4.3): the crumb chain, the filter row's own table, trash's ask,
// and the fetched window's one refusal.
//
// A second copy module, not a bigger first one. `view-copy.ts` answers "what
// is this SHELF" — its title, its count's noun, its caption, how it is empty
// on its own terms. This one answers "what does the screen around those rows
// say", which changes on its own schedule and is read by a different set of
// components. Splitting them also keeps each file under the repo's size cap
// without a waiver, which is the honest version of "this file is doing two
// jobs".
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

// ---------------------------------------------------------------------------
// The sort menu (§4.1's `DSORTS`)
// ---------------------------------------------------------------------------

/**
 * The named orders, in the order the menu lists them.
 *
 * THE MENU IS NOT A SECOND SORT CONTROL, it is the same one said in sentences.
 * A column head can be pressed twice to reverse it, which is fast once you know
 * it and invisible until you do; this list names both directions of the order
 * that has two useful ones and one direction of each order that does not. A
 * member who wants their oldest documents reads "oldest first" here instead of
 * discovering that Changed toggles.
 *
 * Every entry resolves to a (key, direction) pair the heads also produce, so
 * the two controls can never disagree about what the drive is showing.
 */
export const SORT_OPTIONS: readonly SortOption[] = [
  { key: "changed", dir: -1, name: "Date changed", sub: "newest first" },
  { key: "changed", dir: 1, name: "Date changed", sub: "oldest first" },
  { key: "name", dir: 1, name: "Name", sub: "A to Z" },
  { key: "kind", dir: 1, name: "Kind", sub: "A to Z" },
  { key: "size", dir: -1, name: "Size", sub: "largest first" },
];

// ---------------------------------------------------------------------------
// The breadcrumb (§1.6)
// ---------------------------------------------------------------------------

/**
 * One crumb. `shelf` is the place it goes; the TRAILING crumb has none —
 * "The trailing crumb owns the place, so it carries the place's menu … Every
 * crumb before it is a link and nothing else." (§1.6, verbatim.)
 */
export interface Crumb {
  label: string;
  /** Where this crumb goes. Absent on the trailing crumb: it is where you are. */
  shelf?: ShelfId;
}

/** The app's own name, first crumb of every chain. */
const ROOT_CRUMB: Crumb = { label: "Docs", shelf: null };

/**
 * §1.6's crumb chains, one per shelf. A folder's chain goes THROUGH Folders
 * because that is where the member reached it from — the same fact
 * `stripShelf`/`bandActiveId` encode for the strip and the band, so the three
 * surfaces cannot disagree about where a folder sits.
 */
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
 * The place's menu (§1.6), hung off the trailing crumb.
 *
 * THIS IS THE POINTER SURFACE'S ONLY DOOR to the seven destinations that are
 * off the shelf strip. The strip holds five tabs and is not growing to
 * thirteen; the compact band reaches the rest through its More sheet; at a
 * desk there is no More sheet, so without this menu every one of these routes
 * would exist and be unreachable.
 *
 * IT LIVES HERE, NOT IN A ROUTE, because more than one route draws the
 * breadcrumb. It was defined inside `DriveRoute.tsx` while the drive was the
 * only screen that opened with a crumb row, and the moment Folders opened with
 * one too the menu had to be either copied or moved. A door that exists on
 * some screens and not others is not a door.
 */
export interface PlaceMenuItem {
  label: string;
  shelf: ShelfId;
  /** The destination's shape (`icons.ts` `PLACE_ICONS`). Every row has one:
   *  a menu where some rows carry a glyph and others carry a gap reads as a
   *  menu with something missing. */
  icon: keyof typeof PLACE_ICONS;
  /** Start a new group above this row. The menu is not one list of seven —
   *  it is three answers to three different questions (how do I put something
   *  in, what is this drive costing me, what may this app read), and a rule
   *  between them is what lets a member stop reading once they are in the
   *  right group. */
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

// ---------------------------------------------------------------------------
// The filter row (§4.2)
// ---------------------------------------------------------------------------

/**
 * §4.2's four properties, with the spec's own option words.
 *
 * `live` is the same honesty flag `MORE_ROWS` carries: an axis is rendered
 * only where THIS DRIVE can answer it from what it has actually read. People
 * is off because no read on this surface returns an owner, a share or the
 * names a document mentions — a pill whose options cannot be computed is a
 * control that would either do nothing or, worse, filter by a fact the app
 * invented. The row keeps the axis so the agent who lands the names capability
 * flips one flag rather than re-deriving §4.2's copy.
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
    options: [
      "Owned by you",
      "Owned by Ana",
      "Names Tom Pemberton",
      "Shared with Family",
    ],
    live: false,
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

/** §4.2's link, which appears only once at least one filter is set. */
export const CLEAR_FILTERS = "Clear filters";

// ---------------------------------------------------------------------------
// The Search shelf's field
// ---------------------------------------------------------------------------

/** The placeholder, verbatim from the v11 handoff's docs `search` scene
 *  (`fieldBlock('right of way', 'Search titles and contents', true)`). It
 *  names the TWO things this search reaches, which is the promise the shelf
 *  then has to keep — and it is deliberately shorter than the topbar field's
 *  old "Search documents, contents, people…", which offered a people axis
 *  this drive does not have. */
export const SEARCH_PLACEHOLDER = "Search titles and contents";

/** The field's accessible name. The placeholder is not one: it disappears the
 *  moment a member types, and a control that loses its name mid-use is a
 *  control a screen reader cannot go back and re-read. */
export const SEARCH_LABEL = "Search documents by title or contents";

/** The clear affordance is a WORD beside the field, not an icon button
 *  (handoff `clearCss` — underlined text). Same word Photos uses. */
export const SEARCH_CLEAR = "Clear";

/**
 * What this search actually reaches, in one seat-honest phrase
 * (docs/blueprint-seats.md §Worked example: search). `queries/search.ts` runs
 * FTS5 over the vault's own index on the gateway on every keystroke — there is
 * no replica in the path on this surface — so the claim is the live library,
 * literally. Mobile searches an on-device replica and owes a different
 * sentence; it does not read this constant.
 */
export const SEARCH_SCOPE = "the live library";

/** The resting panel's example queries, verbatim from the handoff's docs
 *  `search` scene. They are literal: a member can type any of them back and
 *  this drive will answer. */
export const SEARCH_EXAMPLES: readonly string[] = [
  "right of way",
  "lease expiry",
  "anything from the solicitor",
  "scans with no folder",
  "xlsx over 1 MB",
];

/**
 * The four states the Search shelf can be in, in the product's own words
 * (`_shared/SearchScaffold.tsx` renders them; this file is the only place
 * that says them).
 *
 * ONE HANDOFF SENTENCE IS DELIBERATELY NOT COPIED. Its miss body ends "One
 * letter short of a phrase in two of your documents" — a near-miss claim that
 * would need an edit-distance pass over the index nobody has run. Printing it
 * would be the screen inventing a fact, which is the one thing these panels
 * exist to stop. The rest of the sentence, which names what WAS searched, is
 * verbatim.
 */
export const SEARCH_COPY = {
  resting: {
    eyebrow: "Nothing typed",
    title: "Search titles and contents, across the whole library",
    body: "Not the page that happens to be loaded. Try one of these.",
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

// ---------------------------------------------------------------------------
// Trash's ask (§4.3 `trash`, §14)
// ---------------------------------------------------------------------------

/**
 * THE ASK, NOT THE VERB — and on screen it is a label plus one sentence.
 *
 * THE RATIONALE, which this panel used to print at a member standing in
 * Trash: "There is no destroy verb in the platform today; destruction happens
 * only on the purge schedule." (§4.3, verbatim.) Photos shipped an emptiable
 * trash and Docs is where it matters most — a scanned passport should be gone
 * when a member says so — so what is asked for is two typed commands (destroy
 * one document, destroy everything in trash), confirmed exactly as Photos
 * confirms it: an outlined --net button, the count named, no default. If the
 * ask is refused, the shelf says once, plainly, why destruction is scheduled.
 *
 * That is a design note, and a design note is not copy (DESIGN.md → Copy). The
 * shelf shows the eyebrow — so the title is never mistaken for a control that
 * failed — the title, and `TRASH_FALLBACK`'s one sentence.
 */
export const TRASH_ASK = {
  eyebrow: "Not available yet",
  title: "Delete forever and Empty trash",
} as const;

/** §14's fallback wording — the sentence the shelf says while the ask stands. */
export const TRASH_FALLBACK =
  "Destruction happens only on the schedule a purge date announces, so a trash cannot be emptied.";

// ---------------------------------------------------------------------------
// The fetched window (§4.1 state slot rung 1)
// ---------------------------------------------------------------------------

/** What the window says when the read for the rows beyond it came back
 *  failed. A refusal, in the `net` role, and the ONLY thing rung 1 ever says —
 *  a window still in flight says nothing at all. */
export const WINDOW_FAILED = "could not be fetched";

// ---------------------------------------------------------------------------
// The Folders shelf (§4.3)
// ---------------------------------------------------------------------------

/**
 * The caption under the folder rows.
 *
 * "Never a sentence on a row: the caption under the set carries the prose,
 * once." (§4.1, verbatim.) The Unfiled row used to break that rule by itself —
 * it printed *"N never put anywhere. Not an error, and not a folder"* in the
 * cell where every other row prints a number, which is both a sentence on a
 * row and a column that means two different things depending on which row you
 * read. The number stayed; the sentence came here, where the drive's prose
 * lives.
 */
export function foldersCaption(unfiled: number): string {
  const those =
    unfiled === 1 ? "one document was" : `${unfiled} documents were`;
  return unfiled === 0
    ? "A folder is a label on the document, not a place it sits."
    : `A folder is a label on the document, not a place it sits. Unfiled is not a folder — ${those} never given one, which is not an error.`;
}
