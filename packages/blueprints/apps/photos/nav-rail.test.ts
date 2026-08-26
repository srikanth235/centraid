// Photos' rail as a table (v16 §4): groups + rule in order; every row routes;
// a sub-state lights its shelf; counts from the ONE map.
import { describe, expect, it } from "vitest";

import type { NavRailItem } from "../_shared/NavRail.tsx";
import { ALBUMS, DUPLICATES, FAVORITES, TRASH } from "./constants.ts";
import { photosNavRail, railDrawnOn, railShelf } from "./nav-rail.ts";
import {
  PEOPLE,
  PLACES,
  SEARCH,
  STORAGE,
  personShelf,
  shelfRoute,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

const COUNTS = new Map<string, number>([
  ["library", 6214],
  [FAVORITES, 128],
  [ALBUMS, 14],
  [PLACES, 42],
  [TRASH, 24],
]);

const build = (shelf: ShelfId = null): NavRailItem[] =>
  photosNavRail({ shelf, counts: COUNTS, onSelect: () => {} });

const shape = (items: readonly NavRailItem[]): string[] =>
  items.map((item) =>
    item.kind === "row"
      ? item.label
      : item.kind === "head"
        ? `# ${item.label}`
        : "——"
  );

describe("Photos' navigation rail", () => {
  it("is two groups and a rule, with the library's STATES below it", () => {
    expect(shape(build())).toStrictEqual([
      "# Library",
      "Library",
      "Favorites",
      "# Collections",
      "Albums",
      "Places",
      "People",
      "——",
      "Duplicates",
      "Trash",
    ]);
  });

  it("lists no destination the app cannot route to", () => {
    // Every row routes; rail-only would read as Library.
    const rowIds: ShelfId[] = [
      null,
      FAVORITES,
      ALBUMS,
      PLACES,
      PEOPLE,
      DUPLICATES,
      TRASH,
    ];
    for (const id of rowIds.slice(1)) {
      expect(shelfRoute(id)).not.toBe("photos");
    }
    expect(shelfRoute(null)).toBe("photos");
  });

  it("marks the shelf the member is standing on, and only that one", () => {
    const current = (shelf: ShelfId): string[] =>
      build(shelf)
        .filter((item) => item.kind === "row" && item.current)
        .map((item) => (item.kind === "row" ? item.label : ""));
    expect(current(null)).toStrictEqual(["Library"]);
    expect(current(TRASH)).toStrictEqual(["Trash"]);
    // Inside an album, **Albums** is current — definition of done.
    expect(current("collection-7")).toStrictEqual(["Albums"]);
    expect(current(personShelf("p1"))).toStrictEqual(["People"]);
    // An unlisted shelf lights NOTHING, not nearest row.
    expect(current(STORAGE)).toStrictEqual([]);
  });

  it("reads its counts from the map, and draws none where none was read", () => {
    const counts = build().flatMap((item) =>
      item.kind === "row" ? [[item.label, item.count] as const] : []
    );
    expect(Object.fromEntries(counts)).toStrictEqual({
      Library: 6214,
      Favorites: 128,
      Albums: 14,
      Places: 42,
      // People/Duplicates answer `null` until lazy reads land.
      People: undefined,
      Duplicates: undefined,
      Trash: 24,
    });
  });

  it("draws where the strip drew — everywhere but Search", () => {
    expect(railDrawnOn(null)).toBe(true);
    expect(railDrawnOn(ALBUMS)).toBe(true);
    expect(railDrawnOn("collection-7")).toBe(true);
    // Storage keeps a rail though §4 lists it: withdrawing strands the seat.
    expect(railDrawnOn(STORAGE)).toBe(true);
    expect(railDrawnOn(SEARCH)).toBe(false);
  });

  it("resolves a sub-state to its shelf and refuses to guess otherwise", () => {
    expect(railShelf("collection-7")).toBe(ALBUMS);
    expect(railShelf(personShelf("p1"))).toBe(PEOPLE);
    expect(railShelf(SEARCH)).toBeUndefined();
    expect(railShelf(STORAGE)).toBeUndefined();
  });
});
