// The FOLDERS shelf (Docs spec §4.3 `folders`) — the shelf that replaced the
// folder-tree rail.
//
// "Cut: a folder tree in a rail. Two navigation columns in one window is what
// invariant 1 refuses. Folders are a breadcrumb and a shelf." (spec §14,
// verbatim.) This is the shelf half of that sentence: one row per folder, its
// document count, and a way in.
//
// "A folder is a label on the document, not a place it sits" (§2 row 3) — which
// is why the last row is UNFILED and is not a folder. A document that carries
// no folder label is not lost and is not an error; it simply never had one put
// on it, and a shelf that hid it would be hiding the majority of most drives.
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import { folderShelf } from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";
import type { DriveDoc, Folder } from "../types.ts";
import { GONE_FOLDER_NOTE } from "../view-state.ts";

import styles from "./FoldersRoute.module.css";

export function FoldersRoute({
  folders,
  activeDocs,
  goneFolder,
  onSelectShelf,
}: {
  folders: Folder[];
  /** Every untrashed document, so each row counts its own without a
   *  second read. */
  activeDocs: DriveDoc[];
  /** The member was just moved here because the folder they were on no longer
   *  exists (view-state.ts rule 2). The shelf owes them the reason. */
  goneFolder: boolean;
  onSelectShelf: (shelf: ShelfId) => void;
}): ReactNode {
  const unfiled = activeDocs.filter((d) => !d.folder_id).length;
  return (
    <div className={styles.wrap}>
      {goneFolder ? (
        // Not a toast and not an error strip: the member navigated, and this
        // is the destination explaining why it is the destination.
        <p className={styles.gone}>{GONE_FOLDER_NOTE}</p>
      ) : null}
      <div className={styles.rows}>
        {folders.map((folder) => {
          const count = activeDocs.filter(
            (d) => (d.folder_id ?? null) === folder.folder_id
          ).length;
          return (
            <button
              key={folder.folder_id}
              type="button"
              className={styles.row}
              onClick={() => onSelectShelf(folderShelf(folder.folder_id))}
            >
              <span className={styles.label}>{displayText(folder.name)}</span>
              <span className={styles.meta}>
                {count} {count === 1 ? "document" : "documents"}
              </span>
            </button>
          );
        })}
        {/* Unfiled is a fact about the drive, not a folder — so it has no
            folder id, carries no menu, and says what it is. */}
        <div className={styles.row} data-static="true">
          <span className={styles.label}>Unfiled</span>
          <span className={styles.meta}>
            {unfiled} never put anywhere. Not an error, and not a folder
          </span>
        </div>
      </div>
      <p className={styles.note}>
        A folder is a label on the document, not a place it sits.
      </p>
    </div>
  );
}
