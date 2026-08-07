import { describe, expect, test } from "vitest";

import { sectionPhotoAssets } from "./timeline-model";
import type { PhotoAsset } from "./timeline-model";
import {
  DAY_ROW_HEIGHT,
  MONTH_ROW_HEIGHT,
  buildRows,
  dayAtOffset,
  dayPlace,
  describeCounts,
  monthHeaderIndices,
  monthLabelAt,
  rowTops,
} from "./timeline-rows";

function asset(overrides: Partial<PhotoAsset> & { id: string }): PhotoAsset {
  return {
    uri: "file:///a.jpg",
    previewUri: "file:///a.jpg",
    originalUri: "file:///a.jpg",
    capturedAt: "2026-08-04T10:00:00.000Z",
    kind: "photo",
    favorite: false,
    archived: false,
    deleted: false,
    backupState: "backed-up",
    source: "replica",
    width: 4000,
    height: 3000,
    ...overrides,
  };
}

describe("month and day labels (handoff §4.3)", () => {
  test("the month count names photographs and videos", () => {
    expect(
      describeCounts([
        ...Array.from({ length: 86 }, (_, i) => asset({ id: `p${i}` })),
        ...Array.from({ length: 4 }, (_, i) =>
          asset({ id: `v${i}`, kind: "video" })
        ),
      ])
    ).toBe("86 photographs · 4 videos");
  });

  test("a count of zero videos is not stated — that would be chrome", () => {
    expect(describeCounts([asset({ id: "p" })])).toBe("1 photograph");
  });

  // The day sub-label carries the PLACE and no tally. The counts left the
  // timeline entirely (issue 712 iOS parity) — `describeCounts` above is kept
  // for the Years/Months period cards, which summarise a period the member
  // cannot see the whole of, and this asserts the timeline no longer prints
  // one.
  test("the day sub-label is the place alone, with no count in it", () => {
    const places = new Map([["pl1", "Lyme Regis"]]);
    const dayAtOnePlace = Array.from({ length: 12 }, (_, i) =>
      asset({ id: `a${i}`, placeId: "pl1" })
    );
    expect(dayPlace(dayAtOnePlace, places)).toBe("Lyme Regis");
  });

  test("a day spread across places states no place rather than guessing", () => {
    const places = new Map([
      ["pl1", "Lyme Regis"],
      ["pl2", "Charmouth"],
    ]);
    expect(
      dayPlace(
        [
          asset({ id: "a", placeId: "pl1" }),
          asset({ id: "b", placeId: "pl2" }),
        ],
        places
      )
    ).toBe("");
  });

  test("a day with no known place prints nothing rather than a hedge", () => {
    expect(dayPlace([asset({ id: "a" })], new Map())).toBe("");
  });
});

describe("the row list", () => {
  const assets = [
    asset({ id: "a", capturedAt: "2026-08-04T10:00:00.000Z" }),
    asset({ id: "b", capturedAt: "2026-08-04T11:00:00.000Z" }),
    asset({ id: "c", capturedAt: "2026-08-03T11:00:00.000Z" }),
    asset({ id: "d", capturedAt: "2026-07-30T11:00:00.000Z" }),
  ];
  const sections = sectionPhotoAssets(assets, new Date("2026-08-04T12:00:00Z"));
  const rows = buildRows(sections, 390, 120);

  test("a month header is emitted once per month, not once per day", () => {
    const months = rows.filter((row) => row.type === "month");
    // Three days across two months → two month headers.
    expect(months).toHaveLength(2);
    expect(rows.filter((row) => row.type === "day")).toHaveLength(3);
  });

  test("the sticky indices point at the month headers", () => {
    for (const index of monthHeaderIndices(rows)) {
      expect(rows[index]!.type).toBe("month");
    }
  });

  test("every asset reaches a tile", () => {
    const tiles = rows.flatMap((row) =>
      row.type === "assets" ? row.tiles : []
    );
    expect(tiles).toHaveLength(assets.length);
  });

  test("row tops are the running sum of the row heights", () => {
    const tops = rowTops(rows);
    expect(tops[0]).toBe(0);
    expect(tops[1]).toBe(rows[0]!.height);
    expect(rows[0]!.height).toBe(MONTH_ROW_HEIGHT);
    expect(rows[1]!.height).toBe(DAY_ROW_HEIGHT);
  });

  test("the scrub bubble names the month the row belongs to", () => {
    const firstMonth = rows.find((row) => row.type === "month");
    expect(monthLabelAt(rows, 2)).toBe(
      firstMonth?.type === "month" ? firstMonth.title : ""
    );
    // A row before any header still resolves to a month rather than blank.
    expect(monthLabelAt(rows, 0)).not.toBe("");
  });

  test("a scroll offset resolves to the section day the member is looking at", () => {
    // The grain control asks this to keep a member's place when they switch to
    // Years or Months, so the answer has to be a `PhotoSection.day` and it has
    // to track the scroll rather than the sticky month header above it.
    const tops = rowTops(rows);
    // The top of the list is the newest day, whatever rows precede it.
    expect(dayAtOffset(rows, tops, 0)).toBe("2026-08-04");
    // Deep enough to have passed into July: the July month header is sticky
    // over its own days, but the day underneath is what is reported.
    const july = rows.findIndex((row) => row.key === "d:2026-07-30");
    expect(dayAtOffset(rows, tops, tops[july]!)).toBe("2026-07-30");
    expect(dayAtOffset(rows, tops, tops[july]! + 4)).toBe("2026-07-30");
    // Past the end of the content still names the last day, never undefined —
    // an over-scrolled list has not left the library.
    expect(dayAtOffset(rows, tops, 999_999)).toBe("2026-07-30");
  });

  test("changing the rung repacks without losing or reordering assets", () => {
    const small = buildRows(sections, 390, 64).flatMap((row) =>
      row.type === "assets" ? row.tiles.map((tile) => tile.asset.id) : []
    );
    const large = buildRows(sections, 390, 168).flatMap((row) =>
      row.type === "assets" ? row.tiles.map((tile) => tile.asset.id) : []
    );
    expect(small).toStrictEqual(large);
  });
});
