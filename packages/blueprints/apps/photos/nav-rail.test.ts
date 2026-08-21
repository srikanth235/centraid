// Photos' rail, as a table (v16 §4). What is asserted here is what the handoff
// says out loud and what a reader of the rows cannot otherwise check:
//
//  * the two GROUPS and the rule, in order, and Duplicates and Trash below it;
//  * every row is a shelf the app can route to, so nothing exists only here;
//  * a sub-state lights the shelf it is a sub-state OF — an album lights
//    **Albums**, one person lights **People**;
//  * a count comes from the ONE counts map, and an unread shelf draws none.
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
    // Every row is a shelf with a route, which is what makes the same
    // destinations reachable on touch through the band and the strip. A row
    // that existed only in the rail would route to `photos` and be
    // indistinguishable from Library.
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
    // Inside an album, **Albums** is the current row — the definition of done
    // says so outright, and an album's id is a collection token in no table.
    expect(current("collection-7")).toStrictEqual(["Albums"]);
    // One person's timeline is a sub-state of People for the same reason.
    expect(current(personShelf("p1"))).toStrictEqual(["People"]);
    // A shelf the rail does not list lights NOTHING rather than the row
    // nearest to it.
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
      // People and Duplicates answer `null` until their own lazy reads land,
      // so the map carries no entry and the rail draws no number.
      People: undefined,
      Duplicates: undefined,
      Trash: 24,
    });
  });

  it("draws where the strip drew — everywhere but Search", () => {
    expect(railDrawnOn(null)).toBe(true);
    expect(railDrawnOn(ALBUMS)).toBe(true);
    expect(railDrawnOn("collection-7")).toBe(true);
    // Storage keeps a rail though §4 lists it: the strip draws there today and
    // withdrawing both would leave a desk seat with no way back into the
    // library but the frame's own stem.
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
