// What the Docs view is ALLOWED to say about itself, given what has actually
// been read (Docs spec §2 rows 25–31, §4.6, §11). The three rules and
// `libraryReachability` live in `_shared/view-state-kit.ts`. Docs' own
// instances of them:
//
//  1. The drive projection is `[]` before the first read resolves, so until
//     `loaded` the view paints skeleton rows at the row geometry rather than
//     saying "This drive is empty".
//
//  2. Docs used to reset `nav` to All whenever the open folder vanished from a
//     read — for the ordinary case of a folder deleted in another window. The
//     fall-back is FOLDERS, not All, because the folder was reached from there;
//     and the move is ANNOUNCED (`goneFolder`) so the shelf can say what
//     happened. That is the spec's own "A document whose folder has gone"
//     framing (§4.3 `folders`), applied to navigation.
import { showsEmptyState } from "../_shared/view-state-kit.ts";
import type { EmptyStateGate } from "../_shared/view-state-kit.ts";
import { FOLDERS, folderIdFrom } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import { emptyCopy } from "./view-copy.ts";
import type { EmptyCopy } from "./view-copy.ts";

/**
 * Which shelf survives a read landing, and whether the member has to be told.
 *
 * TRASH is deliberately absent: an empty trash is a state, not a reason to
 * move the member ("Trash is empty." is exactly its own terms). The ONLY shelf
 * that cannot survive is a folder id the read no longer carries — the folder
 * was deleted, so there is no view left to render.
 */
export interface ShelfAfterRead {
  shelf: ShelfId;
  /** The member was moved, and the destination owes them the reason. */
  goneFolder: boolean;
}

export function shelfAfterRead(
  shelf: ShelfId,
  folderIds: readonly string[]
): ShelfAfterRead {
  const folderId = folderIdFrom(shelf);
  if (!folderId) return { shelf, goneFolder: false };
  return folderIds.includes(folderId)
    ? { shelf, goneFolder: false }
    : { shelf: FOLDERS, goneFolder: true };
}

/** §4.3's framing for a folder that is no longer there — the sentence the
 *  Folders shelf owes a member it just moved. */
export const GONE_FOLDER_NOTE =
  "That folder no longer exists. The label has nothing on the other end; refile anything that carried it from here.";

/** What the current view knows about itself when it has nothing to show. */
export interface EmptyStateInput extends EmptyStateGate {
  shelf: ShelfId;
  /** The live search text, trimmed. A miss is about what the member just
   *  typed, not about the shelf. */
  query?: string;
  /** A kind or tag filter is set — the fourth empty variant (§4.6). */
  filtered?: boolean;
  /** The open folder's name, for the empty-folder variant. */
  folderName?: string;
  /** The drive as a whole holds nothing — the one first-run state, and the
   *  only one that gets the display serif. */
  driveIsEmpty?: boolean;
}

export interface EmptyStateView extends EmptyCopy {
  /** Render the block at all. False leaves the region hidden entirely. */
  visible: boolean;
}

/**
 * Nothing to draw, and — critically — nothing to SAY. Exported because the
 * shelves that answer their own empty view (Due draws its capability panel,
 * Storage draws prose) must take the block DOWN through the same one door
 * every other view puts it up through.
 */
export const NO_EMPTY_STATE: EmptyStateView = {
  visible: false,
  variant: "shelf",
  display: false,
  title: "",
  body: "",
};

/** The empty block for the current view, or `visible: false`. */
export function emptyStateView(input: EmptyStateInput): EmptyStateView {
  const query = input.query?.trim() ?? "";
  if (!showsEmptyState(input)) return NO_EMPTY_STATE;
  return {
    visible: true,
    ...emptyCopy(input.shelf, {
      ...(query ? { query } : {}),
      ...(input.filtered ? { filtered: true } : {}),
      ...(input.folderName ? { folderName: input.folderName } : {}),
      ...(input.driveIsEmpty ? { driveIsEmpty: true } : {}),
    }),
  };
}

/** §2 row 26 / §11's banner, as the shared kit reads it — never invented. */
export { libraryReachability } from "../_shared/view-state-kit.ts";
