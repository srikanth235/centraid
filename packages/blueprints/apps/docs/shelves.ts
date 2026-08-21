// The six shelves, the compact band's destinations, and the route mapping
// (Docs spec §1.1, §1.2, §1.4, §1.7).
//
// The structure — id model, route round trip, band tab — is
// `_shared/shelves.ts`, because the two apps are two routes inside one
// frame and a member should not have to learn two navigation models. This file
// is Docs' TABLES.
//
// THE ROUTE ID IS `docs`, NOT the prototype's `dx`. `docs` is the installed app
// id, the manifest id, the launcher key and what every other surface in the
// repo already says; `dx` was the prototype's screen-state key and naming the
// route after it would fork the vocabulary for no gain.
import { createShelfRoutes, tokenFromShelf } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

// The shelves that need an id. The `built-in:` prefix can never collide with a
// folder id, which is an opaque concept token and never carries a colon —
// the same one-slot trick `photos/shelves.ts` uses.
export const FOLDERS = "built-in:folders";
export const RECENT = "built-in:recent";
export const STARRED = "built-in:starred";
export const TRASH = "built-in:trash";
/** Search is a shelf (§4.3), reached from the band and the frame — not a field
 *  in a header the app draws for itself. */
export const SEARCH = "built-in:search";
/** What the drive weighs, where the bytes are, what can be released (§4.5).
 *  Off the strip, in the More sheet — the same place Photos puts it. */
export const STORAGE = "built-in:storage";
/** The four ways in (§4.4). A route, not a menu, so it can be described. */
export const NEWDOC = "built-in:newdoc";
/** Where documents are born on a phone (§4.4). */
export const SCAN = "built-in:scan";
/** What Docs may read — four capabilities, four separate consents (§10.8). */
export const CAPABILITIES = "built-in:capabilities";
/** What Docs would propose about where a new document belongs (§10.7 `filing`). */
export const FILING = "built-in:filing";
/** The people a document names (§10.7 `names`) — Docs' first cross-app link. */
export const NAMES = "built-in:names";
/** Where a document ends and a credential begins (§14). */
export const LOCKER = "built-in:locker";

/** One folder's own sub-state of the Folders shelf: the same drive under a
 *  filter, exactly as one person's timeline is in Photos. */
const FOLDER_PREFIX = "folder:";

/** The shelf id for one folder, from its folder id. */
export function folderShelf(folderId: string): string {
  return `${FOLDER_PREFIX}${folderId}`;
}

/** The folder id behind a folder shelf, or null for any other shelf. */
export function folderIdFrom(id: ShelfId): string | null {
  return tokenFromShelf(FOLDER_PREFIX, id);
}

/**
 * `DSHELVES` (§1.7), in order. Search is deliberately absent: it is a shelf the
 * band and the frame reach, not a seventh tab. So are Storage, Add and Scan —
 * §1.5 puts those in the band's More sheet.
 */
export const DSHELVES: readonly Shelf[] = [
  { id: null, label: "All", segment: "" },
  { id: FOLDERS, label: "Folders", segment: "folders" },
  { id: RECENT, label: "Recently changed", segment: "recent" },
  { id: STARRED, label: "Starred", segment: "starred" },
  { id: TRASH, label: "Trash", segment: "trash" },
];

/** Every shelf that has a route segment, including the ones off the strip. */
const ROUTED: readonly Shelf[] = [
  ...DSHELVES,
  { id: SEARCH, label: "Search", segment: "search" },
  { id: STORAGE, label: "Storage", segment: "storage" },
  { id: NEWDOC, label: "Add a document", segment: "newdoc" },
  { id: SCAN, label: "Scan a document", segment: "scan" },
  { id: CAPABILITIES, label: "What Docs may read", segment: "capabilities" },
  { id: FILING, label: "Proposed filing", segment: "filing" },
  { id: NAMES, label: "Who your documents name", segment: "names" },
  { id: LOCKER, label: "Docs and Locker", segment: "locker" },
];

/**
 * The All shelf's route segment is empty — `docs` IS All — but a band tab and
 * a `aria-current` key need a non-empty id, and the spec's `DBAND` names it
 * `list`. So `list` is the band's id for the root and a synonym `shelfFromSegment`
 * accepts, rather than a second shelf that means the same thing.
 */
const ALL_ID = "list";

/**
 * The compact band Docs claims (§1.4), plus More. The frame supplies the home
 * capsule outside this group and enforces the CAP; there is no floor, which is
 * why removing Coming due left three tabs rather than promoting a fourth. A
 * band tab is a claim about where a member goes most, and inventing one to
 * fill a hole is how a band ends up naming a place nobody asked for.
 *
 * `grid` is NOT here: the grid is a view of All, a sub-state of the same
 * shelf, and a second band tab for the same set would be one place in two.
 */
export const BAND_DESTINATIONS: readonly BandDestination[] = [
  { id: ALL_ID, label: "All" },
  { id: "folders", label: "Folders" },
  { id: "search", label: "Search" },
];

/** The route round trip and the band's active tab (`_shared/shelves.ts`):
 *  `docs` or `docs/<sub>`, one destination either way (§1.1). One folder lights
 *  **Folders**, the shelf it is a sub-state of. */
export const {
  countKey,
  shelfFromSegment,
  shelfSegment,
  shelfRoute,
  shelfFromRoute,
  bandActiveId,
} = createShelfRoutes({
  route: "docs",
  routed: ROUTED,
  band: BAND_DESTINATIONS,
  rootBandId: ALL_ID,
  dynamic: {
    idPrefix: FOLDER_PREFIX,
    segmentPrefix: "folder/",
    fallback: FOLDERS,
    bandKey: "folders",
  },
});

/**
 * Which strip tab is lit for a shelf (§1.7's `shelf` column in the screen
 * index). One folder lights Folders; Search and the sheet destinations light
 * All, because that is the set they were reached from.
 */
export function stripShelf(id: ShelfId): ShelfId {
  if (folderIdFrom(id)) return FOLDERS;
  return DSHELVES.some((shelf) => shelf.id === id) ? id : null;
}

/**
 * The shelves that paint the DRIVE — the document row set (or its grid) under
 * a filter. Folders paints folder rows and the sheet destinations paint their
 * own screens, so none of them takes the drive's filters, its sort, or its
 * view toggle.
 */
const NON_DRIVE: ReadonlySet<string> = new Set([
  FOLDERS,
  STORAGE,
  NEWDOC,
  SCAN,
  CAPABILITIES,
  FILING,
  NAMES,
  LOCKER,
]);

/** Does this shelf paint the document row set? One folder does — it is the
 *  same drive under a filter (§1.7) — and so does Search. */
export function showsDrive(id: ShelfId): boolean {
  if (folderIdFrom(id)) return true;
  return id === null || !NON_DRIVE.has(id);
}

/**
 * May the grid/list toggle mean anything here?
 *
 * Wherever a SET is drawn — every drive shelf, and Folders. This used to
 * delegate to `showsDrive`, which answers the narrower question "does this
 * paint the DOCUMENT row set", and that was the wrong question: Folders paints
 * a set whose every row has a name, a count and a way in, and both
 * arrangements say something true about it. A strip that offered the pair on
 * five tabs and withdrew it on the sixth was changing the furniture under the
 * member for a reason only the code knew.
 */
export function showsViewToggle(id: ShelfId): boolean {
  return showsDrive(id) || id === FOLDERS;
}

/** May `Select` be entered here? Every drive shelf, Trash included — the
 *  selection bar's trash swap (Restore) is what makes that work, exactly as
 *  it does in Photos. */
export function allowsSelection(id: ShelfId): boolean {
  return showsDrive(id);
}

/** Is this the trash? Asked by the row menu, the selection bar and the purge
 *  caption, so it is one predicate rather than three `=== TRASH` literals. */
export function isTrash(id: ShelfId): boolean {
  return id === TRASH;
}
