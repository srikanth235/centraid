// The Docs library's fixed vocabulary: which shelves exist, how they are
// labelled, and how a row in one is identified.
//
// A table rather than screen logic — it grows a row when a shelf is added, and
// it is what both the filter bar and the list key read.

import type { Feather } from "@expo/vector-icons";
import type React from "react";

import type { DriveItem } from "./DocsLibraryItems";

export type LibraryFilter = "all" | "recent" | "starred" | "trash";
export type ViewMode = "list" | "grid";
export const FILTERS: readonly {
  key: LibraryFilter;
  label: string;
  icon: React.ComponentProps<typeof Feather>["name"];
}[] = [
  { key: "all", label: "All", icon: "file-text" },
  { key: "recent", label: "Recent", icon: "clock" },
  { key: "starred", label: "Starred", icon: "star" },
  { key: "trash", label: "Trash", icon: "trash-2" },
];
// Folder and document ids are namespaced separately, so the `f:`/`d:` prefixes
// keep the two arms of DriveItem from colliding on a shared id.
export const driveItemKey = (item: DriveItem): string =>
  item.kind === "folder" ? `f:${item.folder.id}` : `d:${item.document.id}`;
