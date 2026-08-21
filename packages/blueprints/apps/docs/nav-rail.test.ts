// Docs' rail, as a table (v16 §5) — and the folder tree the app's own §14 cut.
//
//  * the DRIVE group, the FOLDERS group with the tree indented under it, the
//    rule, and Trash;
//  * opening a folder marks THAT folder's row current and leaves *Folders*
//    reachable as its own shelf — the thing that makes the tree a filter over
//    one set rather than a second place to be;
//  * Unfiled is in the tree, carries the real number, and is not a route;
//  * a folder's count is the same number the Folders shelf draws.
import { describe, expect, it } from "vitest";

import type { NavRailItem } from "../_shared/NavRail.tsx";
import { folderCounts, unfiledCount } from "./folder-counts.ts";
import { docsNavRail } from "./nav-rail.ts";
import { FOLDERS, RECENT, STARRED, TRASH, folderShelf } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type { DriveDoc, Folder } from "./types.ts";

const folders: Folder[] = [
  { folder_id: "f-prop", name: "Property", parent_id: null },
  { folder_id: "f-money", name: "Money", parent_id: null },
];

const doc = (id: string, folder: string | null): DriveDoc =>
  ({ document_id: id, folder_id: folder }) as DriveDoc;

const activeDocs: DriveDoc[] = [
  doc("d1", "f-prop"),
  doc("d2", "f-prop"),
  doc("d3", "f-money"),
  doc("d4", null),
  doc("d5", null),
  doc("d6", null),
  // A label naming a folder this drive does not have: counted nowhere, and it
  // is NOT unfiled — the document does carry a label.
  doc("d7", "f-gone"),
];

const COUNTS = new Map<string, number>([
  ["list", 7],
  [RECENT, 7],
  [FOLDERS, 2],
  [STARRED, 1],
  [TRASH, 9],
]);

const build = (shelf: ShelfId = null): NavRailItem[] =>
  docsNavRail({
    shelf,
    counts: COUNTS,
    folders,
    activeDocs,
    onSelect: () => {},
  });

const shape = (items: readonly NavRailItem[]): string[] =>
  items.map((item) =>
    item.kind === "row"
      ? `${item.indent ? "  " : ""}${item.label}`
      : item.kind === "head"
        ? `# ${item.label}`
        : "——"
  );

describe("Docs' navigation rail", () => {
  it("is the drive, then the folder tree, then Trash below the rule", () => {
    expect(shape(build())).toStrictEqual([
      "# Drive",
      "All",
      "Recently changed",
      "Starred",
      "# Folders",
      "Folders",
      "  Property",
      "  Money",
      "  Unfiled",
      "——",
      "Trash",
    ]);
  });

  it("opens a folder as its own current row, leaving Folders reachable", () => {
    const items = build(folderShelf("f-prop"));
    const current = items.filter((item) => item.kind === "row" && item.current);
    expect(current).toHaveLength(1);
    expect(current[0]?.kind === "row" && current[0].label).toBe("Property");
    // *Folders* is still a row, still routes, and is NOT lit: the shelf that
    // lists the folders is a different destination from any one of them.
    const foldersRow = items.find(
      (item) => item.kind === "row" && item.label === "Folders"
    );
    expect(foldersRow?.kind === "row" && foldersRow.current).toBeUndefined();
    expect(foldersRow?.kind === "row" && typeof foldersRow.onSelect).toBe(
      "function"
    );
  });

  it("marks a drive shelf where the member is standing on one", () => {
    const current = (shelf: ShelfId): string[] =>
      build(shelf)
        .filter((item) => item.kind === "row" && item.current)
        .map((item) => (item.kind === "row" ? item.label : ""));
    expect(current(null)).toStrictEqual(["All"]);
    expect(current(STARRED)).toStrictEqual(["Starred"]);
    expect(current(FOLDERS)).toStrictEqual(["Folders"]);
    expect(current(TRASH)).toStrictEqual(["Trash"]);
  });

  it("puts Unfiled in the tree with its real number, and gives it no route", () => {
    const unfiled = build().find(
      (item) => item.kind === "row" && item.label === "Unfiled"
    );
    expect(unfiled?.kind === "row" && unfiled.count).toBe(3);
    expect(unfiled?.kind === "row" && unfiled.indent).toBe(true);
    // Not a destination: the drive has no route that shows only the set with
    // no label, and a row that led somewhere else while wearing this number
    // would be lying about where it led.
    expect(unfiled?.kind === "row" && unfiled.onSelect).toBeUndefined();
  });

  it("counts a folder exactly as the Folders shelf does", () => {
    const perFolder = folderCounts(folders, activeDocs);
    const railCounts = build().flatMap((item) =>
      item.kind === "row" && item.indent && item.label !== "Unfiled"
        ? [[item.label, item.count] as const]
        : []
    );
    expect(Object.fromEntries(railCounts)).toStrictEqual({
      Property: perFolder.get("f-prop"),
      Money: perFolder.get("f-money"),
    });
    expect(perFolder.get("f-prop")).toBe(2);
    expect(perFolder.get("f-money")).toBe(1);
    // The orphaned label is in no folder's count and is not unfiled either.
    expect(unfiledCount(activeDocs)).toBe(3);
  });
});
