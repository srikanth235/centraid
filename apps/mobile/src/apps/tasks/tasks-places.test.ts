import { describe, expect, it } from "vitest";

import {
  BAND_DESTINATIONS,
  MORE_SHELVES,
} from "@centraid/blueprints/apps/tasks/shelves";
import { shelfCopy } from "@centraid/blueprints/apps/tasks/view-copy";

import { TASKS_BAND_DESTINATIONS, TASKS_MORE_ROWS } from "./tasks-band";
import {
  TASKS_MORE_PLACES,
  bandKeyFor,
  morePlace,
  placeTitle,
  shelfForPlace,
} from "./tasks-places";

describe("the More sheet's destinations", () => {
  it("gives every row of the sheet a place, in the sheet's own order", () => {
    expect(TASKS_MORE_ROWS.map((row) => morePlace(row.shelf))).toStrictEqual([
      ...TASKS_MORE_PLACES,
    ]);
    expect(TASKS_MORE_PLACES).toHaveLength(MORE_SHELVES.length);
  });

  it("round-trips through the shared shelf table, never a second spelling", () => {
    for (const shelf of MORE_SHELVES) {
      expect(shelfForPlace(morePlace(shelf))).toBe(shelf);
    }
  });

  it("refuses a shelf that is not a More destination", () => {
    expect(() => morePlace(null)).toThrow(/not a More destination/u);
  });

  it("names each place in the web app's own words", () => {
    for (const place of TASKS_MORE_PLACES) {
      expect(placeTitle(place)).toBe(
        shelfCopy(shelfForPlace(place) ?? null).title
      );
    }
  });
});

describe("which band tab is lit", () => {
  it("lights a band place as itself", () => {
    for (const destination of BAND_DESTINATIONS) {
      expect(bandKeyFor(destination.id as "today")).toBe(destination.id);
    }
  });

  it("lights More for the sheet and for every lens behind it", () => {
    expect(bandKeyFor("more")).toBe("more");
    for (const place of TASKS_MORE_PLACES) {
      expect(bandKeyFor(place)).toBe("more");
    }
  });

  it("only ever answers with a tab the band actually draws", () => {
    const keys = TASKS_BAND_DESTINATIONS.map((entry) => entry.key);
    for (const place of [
      ...TASKS_MORE_PLACES,
      "more" as const,
      "today" as const,
    ]) {
      expect(keys).toContain(bandKeyFor(place));
    }
  });
});
