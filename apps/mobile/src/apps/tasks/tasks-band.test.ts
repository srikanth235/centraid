import { describe, expect, it } from "vitest";

// The band's rules, asserted without a renderer (issue #834).
//
// `tasks-band.ts` is deliberately free of `react-native` imports so the CAP,
// the ownership latch and the sheet's contents can be checked as values. What
// this file really guards is that the phone's band and the pointer seats' band
// are one table: the labels are imported from the blueprint, so a rename there
// that did not reach here would fail as a mismatch rather than ship as two
// vocabularies.
import {
  BAND_DESTINATIONS,
  MORE_SHELVES,
} from "@centraid/blueprints/apps/tasks/shelves";

import {
  TASKS_BAND_CAPSULE,
  TASKS_BAND_DESTINATIONS,
  TASKS_BAND_MAX_DESTINATIONS,
  TASKS_MORE_ROWS,
  resolveTasksBand,
} from "./tasks-band";

describe("the band Tasks claims", () => {
  it("sits at the cap: four places plus More", () => {
    expect(TASKS_BAND_DESTINATIONS).toHaveLength(TASKS_BAND_MAX_DESTINATIONS);
    expect(TASKS_BAND_DESTINATIONS.map((entry) => entry.key)).toStrictEqual([
      "today",
      "upcoming",
      "inbox",
      "projects",
      "more",
    ]);
  });

  it("says the blueprint's own words, never a second spelling", () => {
    expect(
      TASKS_BAND_DESTINATIONS.slice(0, 4).map((entry) => entry.label)
    ).toStrictEqual(BAND_DESTINATIONS.map((entry) => entry.label));
  });

  it("gives every tab a label — a glyph alone is not a name", () => {
    for (const destination of TASKS_BAND_DESTINATIONS) {
      expect(destination.label.length).toBeGreaterThan(0);
      expect(destination.icon.length).toBeGreaterThan(0);
    }
  });

  it("keeps the capsule outside the tab group, always", () => {
    expect(TASKS_BAND_CAPSULE.inTabGroup).toBe(false);
    expect(TASKS_BAND_CAPSULE.edge).toBe("leading");
  });

  it("resolves to the app's band by default and the host's on request", () => {
    const app = resolveTasksBand("app");
    expect(app.owner).toBe("app");
    expect(resolveTasksBand("host")).toStrictEqual({ owner: "host" });
  });
});

describe("the More sheet", () => {
  it("carries every lens the band has no room for, in the spec's order", () => {
    expect(TASKS_MORE_ROWS.map((row) => row.shelf)).toStrictEqual([
      ...MORE_SHELVES,
    ]);
  });

  it("never repeats a band destination — a place is in one of the two", () => {
    const bandIds = new Set(BAND_DESTINATIONS.map((entry) => entry.id));
    for (const row of TASKS_MORE_ROWS) {
      expect(bandIds.has(String(row.shelf))).toBe(false);
    }
  });

  it("labels every row and gives it a glyph", () => {
    for (const row of TASKS_MORE_ROWS) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.icon.length).toBeGreaterThan(0);
    }
  });
});
