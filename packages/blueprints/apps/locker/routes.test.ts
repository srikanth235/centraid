import { describe, expect, it } from "vitest";

import { isRoutedScreen } from "./components/Screens.tsx";
import { SURFACE_META, SURFACE_TITLE } from "./route-copy.ts";
import {
  ACCESS,
  BAND_DESTINATIONS,
  EDIT,
  EXPORT,
  FILL,
  GEN,
  IMPORT,
  ITEM,
  LOCK,
  LOCKER_SHELVES,
  MORE_SHELVES,
  SEARCH,
  SETUP,
  TRASH,
  WATCH,
  backRow,
  bandActiveId,
  gatedShelf,
  railShelf,
  shelfFromRoute,
  shelfFromSegment,
  shelfRoute,
  showsItems,
  showsRail,
  suppressesNavigation,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

const ROUTES = [
  "locker/setup",
  "locker/lock",
  "locker",
  "locker/item",
  "locker/edit",
  "locker/gen",
  "locker/watch",
  "locker/search",
  "locker/import",
  "locker/access",
  "locker/trash",
  "locker/export",
  "locker/fill",
];

const OPEN = { setup: false, locked: false, denied: false, refused: false };

describe("the thirteen routes", () => {
  it("names exactly the thirteen the spec draws", () => {
    expect(LOCKER_SHELVES).toHaveLength(13);
    expect(LOCKER_SHELVES.map((shelf) => shelfRoute(shelf.id))).toStrictEqual(
      ROUTES
    );
  });

  it.each(ROUTES)("%s round-trips through the shelf model", (route) => {
    const shelf = shelfFromRoute(route);
    expect(shelfRoute(shelf)).toBe(route);
  });

  it("treats a foreign route as no shelf of this app's", () => {
    expect(shelfFromRoute("tasks/inbox")).toBeNull();
  });

  it("accepts the band's own id for the root, so a band press round-trips", () => {
    expect(shelfFromSegment("items")).toBeNull();
    expect(shelfRoute(shelfFromSegment("items"))).toBe("locker");
  });
});

describe("the phone's band", () => {
  it("claims Items, Review, Generate and Search plus the frame's More", () => {
    expect(BAND_DESTINATIONS.map((dest) => dest.label)).toStrictEqual([
      "Items",
      "Review",
      "Generate",
      "Search",
    ]);
  });

  it.each([
    [null as ShelfId, "items"],
    [WATCH, "watch"],
    [GEN, "gen"],
    [SEARCH, "search"],
    [ITEM, "items"],
    [EDIT, "items"],
  ])("lights %s as %s", (shelf, expected) => {
    expect(bandActiveId(railShelf(shelf))).toBe(expected);
  });

  it.each([IMPORT, ACCESS, TRASH, EXPORT, FILL])(
    "puts %s behind More rather than in the band",
    (shelf) => {
      expect(bandActiveId(shelf)).toBeUndefined();
      expect(MORE_SHELVES).toContain(shelf);
    }
  );

  it("lists the five More surfaces and nothing else", () => {
    expect(MORE_SHELVES).toHaveLength(5);
  });
});

describe("what a route offers", () => {
  it.each([null as ShelfId, GEN, WATCH, SEARCH, IMPORT, ACCESS, TRASH, FILL])(
    "%s draws the rail",
    (shelf) => {
      expect(showsRail(shelf)).toBe(true);
    }
  );

  it.each([SETUP, LOCK, ITEM, EDIT, EXPORT])(
    "%s is a single subject and draws no rail",
    (shelf) => {
      expect(showsRail(shelf)).toBe(false);
    }
  );

  it("paints the item row set on Items alone", () => {
    expect(showsItems(null)).toBe(true);
    for (const shelf of [WATCH, SEARCH, TRASH, ITEM]) {
      expect(showsItems(shelf)).toBe(false);
    }
  });
});

describe("the back row is named for what the member was doing", () => {
  it.each([ITEM, EDIT, GEN])("%s backs out to Items", (shelf) => {
    expect(backRow(shelf)).toStrictEqual({ shelf: null, label: "Items" });
  });

  it.each([WATCH, SEARCH, IMPORT, ACCESS, TRASH, EXPORT, FILL])(
    "%s backs out to Locker",
    (shelf) => {
      expect(backRow(shelf)).toStrictEqual({ shelf: null, label: "Locker" });
    }
  );

  it.each([SETUP, LOCK, null as ShelfId])("%s has no back row", (shelf) => {
    expect(backRow(shelf)).toBeNull();
  });
});

describe("every route above the list is drawn", () => {
  it.each([EDIT, GEN, WATCH, SEARCH, IMPORT, ACCESS, TRASH, EXPORT, FILL])(
    "%s has a screen behind it",
    (shelf) => {
      expect(isRoutedScreen(shelf)).toBe(true);
    }
  );

  it("leaves the list, one item and the two gates to the orchestrator", () => {
    for (const shelf of [null as ShelfId, ITEM, SETUP, LOCK]) {
      expect(isRoutedScreen(shelf)).toBe(false);
    }
  });

  it("draws all thirteen between them, with none left over", () => {
    const orchestrated = new Set<ShelfId>([null, ITEM, SETUP, LOCK]);
    const drawn = LOCKER_SHELVES.filter(
      (shelf) => isRoutedScreen(shelf.id) || orchestrated.has(shelf.id)
    );
    expect(drawn).toHaveLength(LOCKER_SHELVES.length);
  });

  it("names each More surface and what it is for, so the sheet is a choice with reasons", () => {
    for (const shelf of MORE_SHELVES) {
      expect(SURFACE_TITLE[String(shelf)]).toBeDefined();
      expect(SURFACE_TITLE[String(shelf)]).not.toBe("");
      expect(SURFACE_META[String(shelf)]).toBeDefined();
      expect(SURFACE_META[String(shelf)]).not.toBe("");
    }
  });
});

describe("a gate withdraws the spine rather than dimming it", () => {
  it.each([
    ["setup", { ...OPEN, setup: true }],
    ["locked", { ...OPEN, locked: true }],
    ["denied", { ...OPEN, denied: true }],
    ["refused", { ...OPEN, refused: true }],
  ])("%s suppresses the band, the rail and every list", (_name, gate) => {
    expect(suppressesNavigation(gate)).toBe(true);
  });

  it("leaves an open session navigable", () => {
    expect(suppressesNavigation(OPEN)).toBe(false);
  });

  it("forces the gate's own route, whatever was last asked for", () => {
    expect(gatedShelf({ ...OPEN, setup: true }, TRASH)).toBe(SETUP);
    expect(gatedShelf({ ...OPEN, locked: true }, TRASH)).toBe(LOCK);
    expect(gatedShelf({ ...OPEN, setup: true, locked: true }, null)).toBe(
      SETUP
    );
    expect(gatedShelf(OPEN, TRASH)).toBe(TRASH);
  });
});
