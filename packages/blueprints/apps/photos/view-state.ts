// What the Photos view is ALLOWED to say about itself, given what has actually
// been read (v4 handoff §14, README §14). The three rules and
// `libraryReachability` live in `_shared/view-state-kit.ts`. Photos' own
// instances of them:
//
//  1. `visibleAssets()` is `[]` before the first read resolves, so until
//     `loaded` the view paints `--skel` at the packed geometry instead
//     (components/LoadingGrid.tsx) rather than saying "No photographs yet".
//
//  2. §14 requires every shelf to be empty ON ITS OWN TERMS, and "Trash is
//     empty." is exactly those terms. The one shelf that cannot survive a read
//     is an album that no longer exists — nothing left to show, and no words
//     that would make its absence a state.
import { showsEmptyState } from "../_shared/view-state-kit.ts";
import type { EmptyStateGate } from "../_shared/view-state-kit.ts";
import type { ShelfId } from "./shelves.ts";
import {
  emptyCopy,
  emptyOffersImport,
  EMPTY_TITLE,
  personEmptyCopy,
  searchMissTitle,
} from "./view-copy.ts";

/**
 * Which shelf survives a read landing.
 *
 * `TRASH` is deliberately absent from this function: an empty trash is a
 * state, not a reason to move the member. The ONLY shelf that cannot survive
 * is an album id the read no longer carries — the album was deleted, so there
 * is no view left to render and no honest sentence about it either.
 */
export function shelfAfterRead(
  shelf: ShelfId,
  albumIds: readonly string[]
): ShelfId {
  if (shelf === null) return null;
  if (typeof shelf !== "string") return shelf;
  if (
    shelf.startsWith("built-in:") ||
    shelf.startsWith("tag:") ||
    shelf.startsWith("memory:")
  )
    return shelf;
  return albumIds.includes(shelf) ? shelf : null;
}

/** What the current view knows about itself when it has nothing to show. */
export interface EmptyStateInput extends EmptyStateGate {
  shelf: ShelfId;
  /** The live search text, trimmed. A miss is about what the member just
   *  typed, not about the shelf. */
  query?: string;
  inAlbum?: boolean;
  /** One confirmed person's own timeline (§5) — their name, not an id. */
  personName?: string | null;
  /** The compact form factor. `Take a photograph` is offered where a camera
   *  is a real way in (§15's Import row: phone only). */
  phone?: boolean;
}

/** The empty block (§14, proto 4406): one title, one paragraph, two actions. */
export interface EmptyStateView {
  /** Render the block at all. False leaves the region hidden entirely. */
  visible: boolean;
  /** Display serif. The headline the view leads with. */
  title: string;
  /** The reading register — the paragraph, including where the bytes go. */
  body: string;
  /** The filled `Import photographs`. */
  offersImport: boolean;
  /** The outlined `Take a photograph`. */
  offersCamera: boolean;
}

/**
 * Nothing to draw, and — critically — nothing to SAY. Exported because the
 * shelves that answer their own empty view (Search draws §9's four states,
 * Duplicates and Storage draw prose) must take the block DOWN through the same
 * one door every other view puts it up through.
 */
export const NO_EMPTY_STATE: EmptyStateView = {
  visible: false,
  title: "",
  body: "",
  offersImport: false,
  offersCamera: false,
};

/**
 * The empty block for the current view, or `visible: false`.
 *
 * The title/body split is §14's: the display-serif line says what state this
 * is, the reading-register paragraph says what is TRUE about it — and for a
 * library a member could still import into, that includes where the bytes go,
 * which is the load-bearing sentence of the Empty row.
 */
export function emptyStateView(input: EmptyStateInput): EmptyStateView {
  const query = input.query?.trim() ?? "";
  if (!showsEmptyState(input)) return NO_EMPTY_STATE;
  const offersImport = emptyOffersImport(input.shelf, { query });
  return {
    visible: true,
    title: query ? searchMissTitle(query) : EMPTY_TITLE,
    body:
      input.personName && !query
        ? personEmptyCopy(input.personName)
        : emptyCopy(input.shelf, {
            query,
            ...(input.inAlbum ? { inAlbum: true } : {}),
          }),
    offersImport,
    // The camera rides WITH the import offer: a shelf that withholds Import
    // (Trash, a search miss) is not a place a new photograph may land either.
    offersCamera: offersImport && Boolean(input.phone),
  };
}

/** §14 Offline, as the shared kit reads it — never as this app invents it. */
export { libraryReachability } from "../_shared/view-state-kit.ts";
