import type { NavRailItem } from "../_shared/NavRail.tsx";
import { displayText } from "../_shared/untrusted.ts";
import { folderCounts, unfiledCount } from "./folder-counts.ts";
import {
  countKey,
  FOLDERS,
  folderIdFrom,
  folderShelf,
  RECENT,
  SHARED,
  STARRED,
  TRASH,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type { DriveDoc, Folder } from "./types.ts";

const DRIVE_GROUP: readonly { id: ShelfId; label: string }[] = [
  { id: null, label: "All" },
  { id: RECENT, label: "Recently changed" },
  { id: STARRED, label: "Starred" },
  { id: SHARED, label: "Shared with you" },
];

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
        id: folderShelf(folder.folder_id),
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
