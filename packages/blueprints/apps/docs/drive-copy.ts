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
import { FOLDERS, folderIdFrom } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import { SHELF_LABELS } from "./view-copy.ts";

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
// Trash's ask (§4.3 `trash`, §14)
// ---------------------------------------------------------------------------

/**
 * THE ASK, NOT THE VERB. "There is no destroy verb in the platform today;
 * destruction happens only on the purge schedule." (§4.3, verbatim.) So this
 * panel is what Docs asks FOR — and the shelf draws it instead of a control it
 * could not honour. The eyebrow says which kind of thing it is so a member
 * never mistakes it for a button that failed.
 */
export const TRASH_ASK = {
  eyebrow: "An ask · (b)",
  title: "Trash needs Delete forever and Empty trash",
  body: "There is no destroy verb in the platform today; destruction happens only on the purge schedule. Photos shipped an emptiable trash, and Docs is where it matters most — a scanned passport should be gone when a member says so.",
  facts: [
    {
      key: "what is asked",
      value:
        "two typed commands: destroy one document, destroy everything in trash",
    },
    {
      key: "confirmation",
      value:
        "exactly as Photos confirms it — an outlined --net button, the count named, no default",
    },
    {
      key: "the fallback if it is refused",
      value: "the shelf says once, plainly, why destruction is scheduled",
    },
  ],
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
