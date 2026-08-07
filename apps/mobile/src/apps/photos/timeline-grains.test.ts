import { describe, expect, it } from "vitest";

import {
  anchorForGrain,
  buildPeriods,
  periodContaining,
} from "./timeline-grains";
import { UNDATED_SECTION_DAY } from "./timeline-model";
import type { PhotoAsset, PhotoSection } from "./timeline-model";

/** Minimal asset — only `kind` and `id` are ever varied; the rest is filler a
 *  real replica row would also carry. */
function asset(id: string, kind: PhotoAsset["kind"] = "photo"): PhotoAsset {
  return {
    archived: false,
    backupState: "backed-up",
    capturedAt: "2026-01-01T00:00:00.000Z",
    deleted: false,
    favorite: false,
    id,
    kind,
    originalUri: `${id}.jpg`,
    previewUri: `${id}.jpg`,
    source: "device",
    uri: `${id}.jpg`,
  };
}

/** A section as `sectionPhotoAssets` would emit it, spelt out rather than
 *  derived, so a grouping test states the exact input it groups. */
function section(day: string, assets: PhotoAsset[]): PhotoSection {
  const month = day.slice(0, 7);
  return { assets, day, month, monthTitle: `${month} title`, title: day };
}

function undatedSection(assets: PhotoAsset[]): PhotoSection {
  return {
    assets,
    day: UNDATED_SECTION_DAY,
    month: UNDATED_SECTION_DAY,
    monthTitle: "Undated",
    title: "Undated",
  };
}

/** The acceptance library: ~30 frames over 2019–2026 with 2022 missing
 *  entirely, some days holding several frames and some months holding one. */
function lumpyLibrary(): PhotoSection[] {
  const days = [
    "2026-08-06",
    "2026-08-05",
    "2026-03-14",
    "2025-12-31",
    "2025-04-02",
    "2024-11-20",
    "2024-11-19",
    "2023-06-01",
    "2021-09-09",
    "2019-01-05",
  ];
  return days.map((day, index) =>
    section(
      day,
      Array.from({ length: (index % 3) + 1 }, (_, seat) =>
        asset(`${day}-${seat}`)
      )
    )
  );
}

describe("grouping sections into period cards", () => {
  it("groups by the year slice of section.month, keeping the order it was given", () => {
    // Deliberately handed out of calendar order: re-sorting here would put a
    // period view out of step with the All grid it summarises.
    const sections = [
      section("2024-06-01", [asset("z")]),
      section("2026-01-01", [asset("y")]),
      section("2025-01-01", [asset("x")]),
    ];
    expect(
      buildPeriods(sections, "years").map((period) => period.key)
    ).toStrictEqual(["2024", "2026", "2025"]);
  });

  it("takes a month period's title from the section's own monthTitle", () => {
    const sections = [
      section("2026-03-15", [asset("b")]),
      section("2026-03-02", [asset("a")]),
      section("2026-01-10", [asset("c")]),
    ];
    const periods = buildPeriods(sections, "months");
    expect(periods.map((period) => period.key)).toStrictEqual([
      "2026-03",
      "2026-01",
    ]);
    expect(periods[0]!.title).toBe("2026-03 title");
  });

  it("counts every day in the period, in describeCounts' own wording", () => {
    const sections = [
      section("2026-03-15", [asset("a"), asset("b", "video")]),
      section("2026-03-02", [asset("c")]),
    ];
    // 2 photographs (a, c) + 1 video (b) — the whole month, not the 2 the
    // first day alone would report.
    expect(buildPeriods(sections, "months")[0]!.count).toBe(
      "2 photographs · 1 video"
    );
  });

  it("covers a period with its newest photograph, and nothing when it holds none", () => {
    const withAssets = [
      section("2026-03-15", [asset("newest"), asset("older")]),
      section("2026-03-02", [asset("oldest")]),
    ];
    expect(buildPeriods(withAssets, "months")[0]!.cover?.id).toBe("newest");
    expect(
      buildPeriods([section("2026-03-15", [])], "months")[0]!.cover
    ).toBeUndefined();
  });

  it("anchors a period on the day of its first section — the key All scrolls to", () => {
    const sections = [
      section("2026-03-15", [asset("a")]),
      section("2026-03-02", [asset("b")]),
    ];
    expect(buildPeriods(sections, "months")[0]!.anchorDay).toBe("2026-03-15");
    expect(buildPeriods(sections, "years")[0]!.anchorDay).toBe("2026-03-15");
  });

  it("emits no card for a year the library skipped", () => {
    // 2022 holds no photographs, so it holds no section, so it holds no card.
    // The gap is the absence of a period, never an empty one promising frames
    // that are not there.
    const years = buildPeriods(lumpyLibrary(), "years").map(
      (period) => period.key
    );
    expect(years).toStrictEqual([
      "2026",
      "2025",
      "2024",
      "2023",
      "2021",
      "2019",
    ]);
    expect(years).not.toContain("2022");
  });

  it("excludes the Undated section from both summary grains", () => {
    // Undated photographs are visible in All — they exist — but they hold no
    // position in date navigation, so no period card claims them.
    const sections = [
      section("2026-08-06", [asset("dated")]),
      undatedSection([asset("nodate-a"), asset("nodate-b")]),
    ];
    for (const grain of ["years", "months"] as const) {
      const periods = buildPeriods(sections, grain);
      expect(periods).toHaveLength(1);
      expect(periods[0]!.count).toBe("1 photograph");
      expect(periods.some((period) => period.key === UNDATED_SECTION_DAY)).toBe(
        false
      );
    }
  });

  it("shows an all-undated library as no periods at all", () => {
    expect(buildPeriods([undatedSection([asset("a")])], "years")).toStrictEqual(
      []
    );
    expect(
      buildPeriods([undatedSection([asset("a")])], "months")
    ).toStrictEqual([]);
  });
});

describe("finding the period that contains a day", () => {
  it("finds the year holding a day from the All grid", () => {
    const years = buildPeriods(lumpyLibrary(), "years");
    expect(periodContaining(years, "2021-09-09")?.key).toBe("2021");
  });

  it("finds the month holding a day from the All grid", () => {
    const months = buildPeriods(lumpyLibrary(), "months");
    expect(periodContaining(months, "2024-11-19")?.key).toBe("2024-11");
  });

  it("has nothing to anchor on for the Undated section or no day at all", () => {
    const years = buildPeriods(lumpyLibrary(), "years");
    expect(periodContaining(years, UNDATED_SECTION_DAY)).toBeUndefined();
    expect(periodContaining(years, undefined)).toBeUndefined();
  });

  it("has nothing to anchor on for a day the library does not hold", () => {
    const years = buildPeriods(lumpyLibrary(), "years");
    expect(periodContaining(years, "2022-05-01")).toBeUndefined();
  });
});

describe("keeping the member's place across a grain switch", () => {
  it("carries a day from All up to the month, and up again to the year", () => {
    const sections = lumpyLibrary();
    // Deep in 2021 in the All grid; switching to Months must land on the
    // September 2021 card, not on the top of the library.
    const month = anchorForGrain(sections, "months", "2021-09-09");
    expect(month).toBe("2021-09-09");
    expect(periodContaining(buildPeriods(sections, "months"), month)?.key).toBe(
      "2021-09"
    );
    // …and switching on again to Years must land on 2021, reading the place
    // from where Months left it rather than from where All did.
    expect(anchorForGrain(sections, "years", month)).toBe("2021-09-09");
    expect(periodContaining(buildPeriods(sections, "years"), month)?.key).toBe(
      "2021"
    );
  });

  it("carries a place back DOWN a grain, which the drill-down-only predecessor could not", () => {
    const sections = lumpyLibrary();
    const year = anchorForGrain(sections, "years", "2024-11-19");
    expect(year).toBe("2024-11-20");
    // Years → Months → All, all the way back to a day the timeline can scroll
    // to, without the member re-picking a card at each step.
    const month = anchorForGrain(sections, "months", year);
    expect(month).toBe("2024-11-20");
    expect(anchorForGrain(sections, "all", month)).toBe("2024-11-20");
  });

  it("is stable — anchoring a grain to its own anchor day does not drift", () => {
    const sections = lumpyLibrary();
    const first = anchorForGrain(sections, "months", "2026-08-05");
    expect(anchorForGrain(sections, "months", first)).toBe(first);
  });

  it("leaves a grain at its natural top when there is no place to carry", () => {
    const sections = lumpyLibrary();
    expect(anchorForGrain(sections, "years", undefined)).toBeUndefined();
    expect(
      anchorForGrain(sections, "all", UNDATED_SECTION_DAY)
    ).toBeUndefined();
    // A day the filtered sections no longer hold anchors nowhere rather than
    // guessing at the nearest period.
    expect(anchorForGrain(sections, "months", "2022-01-01")).toBeUndefined();
  });
});
