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
      "Shared with you",
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
    expect(unfiledCount(activeDocs)).toBe(3);
  });
});
