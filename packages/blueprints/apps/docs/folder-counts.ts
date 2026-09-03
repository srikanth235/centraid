import type { DriveDoc, Folder } from "./types.ts";

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
    if (seen !== undefined) counts.set(id, seen + 1);
  }
  return counts;
}

export function unfiledCount(activeDocs: readonly DriveDoc[]): number {
  return activeDocs.filter((doc) => !doc.folder_id).length;
}
