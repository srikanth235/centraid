import { describe, expect, test } from "vitest";

import {
  BAND_DESTINATIONS,
  BOOKS,
  CAPTURE,
  HISTORY,
  JOURNAL,
  MORE_SHELVES,
  NOTE,
  SEARCH,
  TAGS,
  TRASH,
  VOICE,
  bandActiveId,
  isEditing,
  notebookIdFrom,
  notebookShelf,
  shelfFromRoute,
  shelfFromSegment,
  shelfRoute,
  showsLibrary,
  showsViewToggle,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

const EVERY_SHELF: readonly ShelfId[] = [
  null,
  BOOKS,
  JOURNAL,
  SEARCH,
  NOTE,
  HISTORY,
  TAGS,
  TRASH,
  CAPTURE,
  VOICE,
];

describe("routes", () => {
  test("every route survives the trip out and back", () => {
    for (const shelf of EVERY_SHELF)
      expect(shelfFromRoute(shelfRoute(shelf))).toBe(shelf);
  });

  test("the library is the app's own route, with no segment", () => {
    expect(shelfRoute(null)).toBe("notes");
    expect(shelfRoute(JOURNAL)).toBe("notes/journal");
    expect(shelfRoute(HISTORY)).toBe("notes/history");
  });

  test("one notebook is the library under a filter, and routes as one", () => {
    const shelf = notebookShelf("nb-7");
    expect(shelfRoute(shelf)).toBe("notes/notebook/nb-7");
    expect(shelfFromRoute("notes/notebook/nb-7")).toBe(shelf);
    expect(notebookIdFrom(shelf)).toBe("nb-7");
    expect(notebookIdFrom(TRASH)).toBeNull();
  });

  test("a segment nobody claims lands on the library, never on the wrong route", () => {
    expect(shelfFromSegment("nowhere")).toBeNull();
    expect(shelfFromRoute("docs/trash")).toBeNull();
  });
});

describe("the phone's band", () => {
  test("five destinations: four places plus the frame's More", () => {
    expect(
      BAND_DESTINATIONS.map((destination) => destination.label)
    ).toStrictEqual(["Library", "Notebooks", "Journal", "Search"]);
  });

  test("only acts sit behind More", () => {
    expect(MORE_SHELVES).toStrictEqual([CAPTURE, VOICE, TAGS, TRASH, HISTORY]);
  });

  test("a notebook lights Library, which is the set it narrows", () => {
    expect(bandActiveId(notebookShelf("nb-7"))).toBe("library");
    expect(bandActiveId(JOURNAL)).toBe("journal");
    expect(bandActiveId(TRASH)).toBeUndefined();
  });
});

describe("what a route draws", () => {
  test("the library and its notebooks paint the same set", () => {
    expect(showsLibrary(null)).toBe(true);
    expect(showsLibrary(notebookShelf("nb-7"))).toBe(true);
    expect(showsLibrary(JOURNAL)).toBe(false);
  });

  test("the arrangement pair means something wherever notes are drawn", () => {
    expect(showsViewToggle(JOURNAL)).toBe(true);
    expect(showsViewToggle(SEARCH)).toBe(true);
    expect(showsViewToggle(TRASH)).toBe(false);
  });

  test("the editor is the one context whose filled control is Link", () => {
    expect(isEditing(NOTE)).toBe(true);
    expect(isEditing(null)).toBe(false);
  });
});
