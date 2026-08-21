// DOCS' NAVIGATION RAIL — the rows, as a pure table (v16 §5).
//
// ```
// DRIVE
//   All                1,908
//   Recently changed      24
//   Starred               18
// FOLDERS
//   Folders                4
//     Property            38
//     Money              104
//     Identity            12
//     The move            26
//     Unfiled          1,728
//   ──────────────────────────
//   Trash                  9
// ```
//
// THE TREE THE FIRST CUT CUT. Docs' spec §14 ruled: *"Cut: a folder tree in a
// rail. Two navigation columns in one window is what invariant 1 refuses.
// Folders are a breadcrumb and a shelf."* That ruling is **reversed**, and it
// is legal now for the reason it was refused then: **a folder is a label**, so
// the tree is a filter over ONE set rather than a second place to be. Invariant
// 1 reserves the band for the frame, and the rail is not a band — the stem
// answers which app, the rail answers where in it.
//
// FOLDERS STAYS ITS OWN SHELF. Opening *Property* marks that folder's row
// current and leaves the *Folders* row above it reachable, because the shelf
// that LISTS the folders is a different destination from any one of them —
// `FoldersRoute` is where a folder is created, renamed and sorted.
//
// UNFILED IS IN THE TREE, and it is the one row here that is not a
// destination. See `NavRailItem["onSelect"]` for why a row with no route is
// drawn as inert text rather than pointed at All: the drive has no route that
// shows only the unlabelled set, and a row that wore its own number while
// leading somewhere else would be lying about where it led.
//
// TWO ROWS OF THE REFERENCE'S RAIL ARE ABSENT, and neither is an omission:
// **Coming due** is not a shelf in this repo (`DSHELVES` carries five, and the
// band claim's own note records that removing it left three tabs rather than
// promoting a fourth), and a rail row for a destination that does not exist is
// the defect §2 names. Every row below is a shelf in `shelves.ts` and is
// therefore reachable on touch through the band or the strip.
import type { NavRailItem } from "../_shared/NavRail.tsx";
import { displayText } from "../_shared/untrusted.ts";
import { folderCounts, unfiledCount } from "./folder-counts.ts";
import {
  countKey,
  FOLDERS,
  folderIdFrom,
  folderShelf,
  RECENT,
  STARRED,
  TRASH,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type { DriveDoc, Folder } from "./types.ts";

/** The **Drive** group — the document set under a filter. */
const DRIVE_GROUP: readonly { id: ShelfId; label: string }[] = [
  { id: null, label: "All" },
  { id: RECENT, label: "Recently changed" },
  { id: STARRED, label: "Starred" },
];

/**
 * The rail, built from the shelf tables, the folder list and ONE counts map —
 * the same map the strip and the More sheet read, so a count here can never
 * disagree with the count for the same shelf anywhere else. Per-folder counts
 * come from `folder-counts.ts`, which the Folders shelf reads too.
 */
export function docsNavRail({
  shelf,
  counts,
  folders,
  activeDocs,
  onSelect,
}: {
  shelf: ShelfId;
  counts: ReadonlyMap<string, number>;
  folders: readonly Folder[];
  /** Every untrashed document — what a folder's own count counts. */
  activeDocs: readonly DriveDoc[];
  onSelect: (id: ShelfId) => void;
}): NavRailItem[] {
  const openFolder = folderIdFrom(shelf);
  const row = (id: ShelfId, label: string): NavRailItem => {
    const count = counts.get(countKey(id));
    return {
      kind: "row",
      id: countKey(id),
      label,
      ...(count === undefined ? {} : { count }),
      // A folder is open, so no drive shelf is current — not even the
      // **Folders** row the member reached it from. The strip lights Folders
      // there (`stripShelf`) because a row of tabs has no row for the folder
      // itself; the rail does have one, and lighting both would be saying the
      // member is standing in two places.
      ...(!openFolder && id === shelf ? { current: true } : {}),
      onSelect: () => onSelect(id),
    };
  };
  const perFolder = folderCounts(folders, activeDocs);
  return [
    { kind: "head", label: "Drive" },
    ...DRIVE_GROUP.map((entry) => row(entry.id, entry.label)),
    { kind: "head", label: "Folders" },
    row(FOLDERS, "Folders"),
    ...folders.map((folder): NavRailItem => {
      const count = perFolder.get(folder.folder_id);
      return {
        kind: "row",
        // The SHELF id, not the bare folder id: it is the row's identity for
        // focus and for React, and `folder:<id>` cannot collide with a
        // built-in shelf key or with the static row below.
        id: folderShelf(folder.folder_id),
        // A folder's name is written by a member and is untrusted text
        // everywhere it is drawn — the Folders shelf takes it through the same
        // gate before painting a row or a card.
        label: displayText(folder.name),
        indent: true,
        ...(count === undefined ? {} : { count }),
        ...(openFolder === folder.folder_id ? { current: true } : {}),
        onSelect: () => onSelect(folderShelf(folder.folder_id)),
      };
    }),
    {
      kind: "row",
      id: "unfiled",
      label: "Unfiled",
      indent: true,
      count: unfiledCount(activeDocs),
    },
    { kind: "rule" },
    row(TRASH, "Trash"),
  ];
}
