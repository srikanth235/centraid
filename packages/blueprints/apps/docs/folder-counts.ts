// HOW MANY DOCUMENTS A FOLDER HOLDS — one expression, two readers.
//
// The Folders shelf and the navigation rail both draw a folder's count beside
// its name, and until v16 the shelf was the only one who knew how to work it
// out. Two surfaces deriving the same number from the same rows in two places
// is how they come to disagree the first time either is edited — and a count
// that disagrees with its shelf header is exactly what §3 of the rail spec
// calls a defect. So it is derived here, once.
//
// A FOLDER IS A LABEL, not a place a document sits (§2). That is why this is a
// filter over the active set rather than a walk of a tree: `folder_id` is the
// label on the row, `null` is the absence of one, and no document is ever in
// two folders or in none by accident.
import type { DriveDoc, Folder } from "./types.ts";

/**
 * Every folder's count, by folder id, over the ACTIVE documents — trashed rows
 * are not in any folder's count, because Trash is its own shelf with its own
 * number and counting a document twice is how a drive's totals stop adding up.
 */
export function folderCounts(
  folders: readonly Folder[],
  activeDocs: readonly DriveDoc[]
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>(
    folders.map((folder) => [folder.folder_id, 0])
  );
  for (const doc of activeDocs) {
    const id = doc.folder_id ?? null;
    if (id === null) continue;
    const seen = counts.get(id);
    // A label naming a folder this drive does not have is not counted anywhere
    // rather than conjuring a row for it: the folder list is the source of
    // which folders exist.
    if (seen !== undefined) counts.set(id, seen + 1);
  }
  return counts;
}

/**
 * The documents carrying no folder label at all.
 *
 * It is not a folder, it is not an error, and it is usually the largest set in
 * the drive — which is the whole reason both surfaces show it. A spine that
 * hid the biggest thing in the drive would be a spine that lies.
 */
export function unfiledCount(activeDocs: readonly DriveDoc[]): number {
  return activeDocs.filter((doc) => !doc.folder_id).length;
}
