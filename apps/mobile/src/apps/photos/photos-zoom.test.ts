import { describe, expect, it } from "vitest";

import { buildPeriods, drillInto } from "./photos-zoom";
import type { PhotoAsset, PhotoSection } from "./timeline-model";

/** Minimal asset — only the fields `describeCounts` and `cover` look at are
 *  ever varied per test, everything else is filler a real replica row would
 *  also carry. */
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

function section(
  day: string,
  month: string,
  monthTitle: string,
  assets: PhotoAsset[]
): PhotoSection {
  return {
    assets,
    day,
    month,
    monthTitle,
    title: day,
  };
}

describe("buildPeriods at the years grain", () => {
  it("groups by the YEAR slice of section.month, not a second parse of capturedAt", () => {
    // Two months of the same year fold onto one period — the header's own
    // argument for why `section.month` is the reference, not `capturedAt`.
    const sections = [
      section("2026-03-15", "2026-03", "March 2026", [asset("c")]),
      section("2026-01-10", "2026-01", "January 2026", [asset("b")]),
      section("2025-12-25", "2025-12", "December 2025", [asset("a")]),
    ];
    const periods = buildPeriods(sections, "years");
    expect(periods.map((period) => period.key)).toStrictEqual(["2026", "2025"]);
  });

  it("preserves the newest-first order it was given, and does not re-sort", () => {
    // Sections deliberately handed out of calendar order — buildPeriods must
    // not silently fix that, since re-sorting here would put Years and All
    // out of step (the header's own "two different libraries" argument).
    const sections = [
      section("2024-06-01", "2024-06", "June 2024", [asset("z")]),
      section("2026-01-01", "2026-01", "January 2026", [asset("y")]),
      section("2025-01-01", "2025-01", "January 2025", [asset("x")]),
    ];
    const periods = buildPeriods(sections, "years");
    expect(periods.map((period) => period.key)).toStrictEqual([
      "2024",
      "2026",
      "2025",
    ]);
  });
});

describe("buildPeriods at the months grain", () => {
  it("groups by section.month and takes its title from monthTitle", () => {
    const sections = [
      section("2026-03-15", "2026-03", "March 2026", [asset("b")]),
      section("2026-03-02", "2026-03", "March 2026", [asset("a")]),
      section("2026-01-10", "2026-01", "January 2026", [asset("c")]),
    ];
    const periods = buildPeriods(sections, "months");
    expect(periods.map((period) => period.key)).toStrictEqual([
      "2026-03",
      "2026-01",
    ]);
    expect(periods.map((period) => period.title)).toStrictEqual([
      "March 2026",
      "January 2026",
    ]);
  });
});

describe("buildPeriods' count", () => {
  it("uses describeCounts' own wording, spanning every day in the period, not just the first", () => {
    const sections = [
      section("2026-03-15", "2026-03", "March 2026", [
        asset("a"),
        asset("b", "video"),
      ]),
      section("2026-03-02", "2026-03", "March 2026", [asset("c")]),
    ];
    const periods = buildPeriods(sections, "months");
    // 2 photographs (a, c) + 1 video (b), matching the month header's own
    // wording (`describeCounts` in timeline-rows.ts) — a count spanning both
    // days, not the 2 the first day alone would report.
    expect(periods[0]!.count).toBe("2 photographs · 1 video");
  });
});

describe("buildPeriods' cover", () => {
  it("is the period's newest asset — the first asset of the first section", () => {
    const sections = [
      section("2026-03-15", "2026-03", "March 2026", [
        asset("newest"),
        asset("older"),
      ]),
      section("2026-03-02", "2026-03", "March 2026", [asset("oldest")]),
    ];
    const periods = buildPeriods(sections, "months");
    expect(periods[0]!.cover?.id).toBe("newest");
  });

  it("is undefined for an empty period", () => {
    const sections = [section("2026-03-15", "2026-03", "March 2026", [])];
    const periods = buildPeriods(sections, "months");
    expect(periods[0]!.cover).toBeUndefined();
  });
});

describe("buildPeriods' anchorDay", () => {
  it("is the day of the period's FIRST section — what the All grid scrolls to", () => {
    const sections = [
      section("2026-03-15", "2026-03", "March 2026", [asset("a")]),
      section("2026-03-02", "2026-03", "March 2026", [asset("b")]),
    ];
    const periods = buildPeriods(sections, "months");
    expect(periods[0]!.anchorDay).toBe("2026-03-15");
  });
});

describe("buildPeriods' year", () => {
  it("equals the key at the year grain", () => {
    const sections = [
      section("2026-03-15", "2026-03", "March 2026", [asset("a")]),
    ];
    const periods = buildPeriods(sections, "years");
    expect(periods[0]!.year).toBe(periods[0]!.key);
    expect(periods[0]!.year).toBe("2026");
  });

  it("equals the year slice of the key at the month grain", () => {
    const sections = [
      section("2026-03-15", "2026-03", "March 2026", [asset("a")]),
    ];
    const periods = buildPeriods(sections, "months");
    expect(periods[0]!.key).toBe("2026-03");
    expect(periods[0]!.year).toBe("2026");
  });
});

describe("drillInto — the grain one step narrower", () => {
  it("years opens months", () => {
    expect(drillInto("years")).toBe("months");
  });

  it("months opens all", () => {
    expect(drillInto("months")).toBe("all");
  });

  it("all opens all — there is nothing below it to drill into", () => {
    expect(drillInto("all")).toBe("all");
  });
});
