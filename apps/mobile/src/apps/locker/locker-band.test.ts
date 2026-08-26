// The band's tables, asserted without rendering (Tasks' `tasks-band.test.ts`
// is the exemplar). What a re-edit is likeliest to undo quietly:
//
//  - the five destinations are the SHARED table's four plus More, in order,
//    and the cap is never exceeded
//  - handing the band back leaves the capsule and takes the tabs
//  - the More sheet's labels and meta come from the shared surface table, so
//    the phone cannot rename a surface the desktop rail already named
//  - EVERY More row leads somewhere: the two this seat performs are routes,
//    and the three whose door is on another seat share one screen that says
//    so, rather than being drawn as controls that would go grey

import { describe, expect, it } from "vitest";

import {
  SURFACE_META,
  SURFACE_TITLE,
} from "@centraid/blueprints/apps/locker/route-copy";
import { BAND_DESTINATIONS } from "@centraid/blueprints/apps/locker/shelves";

import {
  LOCKER_BAND_CAPSULE,
  LOCKER_BAND_DESTINATIONS,
  LOCKER_BAND_MAX_DESTINATIONS,
  LOCKER_MORE_ROWS,
  resolveLockerBand,
  resolveLockerMoreRoute,
} from "./locker-band";

describe("locker band", () => {
  it("claims the shared four places plus More, within the cap", () => {
    expect(LOCKER_BAND_DESTINATIONS.map((d) => d.key)).toStrictEqual([
      ...BAND_DESTINATIONS.map((d) => d.id),
      "more",
    ]);
    expect(LOCKER_BAND_DESTINATIONS.map((d) => d.label)).toStrictEqual([
      "Items",
      "Review",
      "Generate",
      "Search",
      "More",
    ]);
    expect(LOCKER_BAND_DESTINATIONS.length).toBeLessThanOrEqual(
      LOCKER_BAND_MAX_DESTINATIONS
    );
  });

  it("gives every destination a glyph", () => {
    for (const destination of LOCKER_BAND_DESTINATIONS) {
      expect(destination.icon).not.toBe("");
    }
  });

  it("keeps the capsule when the member hands the band back", () => {
    expect(resolveLockerBand("host")).toStrictEqual({ owner: "host" });
    const claimed = resolveLockerBand("app");
    expect(claimed.owner).toBe("app");
    if (claimed.owner !== "app") throw new Error("band was not claimed");
    expect(claimed.capsule).toStrictEqual(LOCKER_BAND_CAPSULE);
    expect(claimed.capsule.inTabGroup).toBe(false);
  });
});

describe("locker More sheet", () => {
  it("takes every label and meta from the shared surface table", () => {
    expect(LOCKER_MORE_ROWS).toHaveLength(5);
    for (const row of LOCKER_MORE_ROWS) {
      expect(row.label).toBe(SURFACE_TITLE[String(row.shelf)]);
      expect(row.meta).toBe(SURFACE_META[String(row.shelf)]);
    }
  });

  it("performs Access history and Trash here and states the rest elsewhere", () => {
    const here = LOCKER_MORE_ROWS.filter((row) => row.reach === "here");
    expect(here.map((row) => row.key)).toStrictEqual(["access", "trash"]);
    const elsewhere = LOCKER_MORE_ROWS.filter(
      (row) => row.reach === "elsewhere"
    );
    expect(elsewhere.map((row) => row.key)).toStrictEqual([
      "import",
      "export",
      "fill",
    ]);
  });

  it("routes every row — no row is a dead control", () => {
    for (const row of LOCKER_MORE_ROWS) {
      expect(resolveLockerMoreRoute(row.key)).not.toBe("");
    }
    expect(resolveLockerMoreRoute("access")).toBe("LockerAccess");
    expect(resolveLockerMoreRoute("trash")).toBe("LockerTrash");
    expect(resolveLockerMoreRoute("import")).toBe("LockerSurface");
    expect(resolveLockerMoreRoute("export")).toBe("LockerSurface");
    expect(resolveLockerMoreRoute("fill")).toBe("LockerSurface");
  });
});
