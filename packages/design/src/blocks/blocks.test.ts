// The headless block layer, pinned once (#765).
//
// These are the claims both kits used to make separately, so they are asserted
// here and nowhere else: the kit tests keep their render assertions (which node
// takes `net`, which style takes the touch floor) and stop restating the
// arithmetic.
import { describe, expect, it } from "vitest";

import {
  barShares,
  barStack,
  barWindow,
  boneDelay,
  boneWidths,
  dayFold,
  dayMark,
  DISTRIBUTION_FIXTURE,
  distributionRows,
  docRowMenu,
  docSnipLine,
  GRID_CLIP_AT,
  gridCell,
  gridColumnBadges,
  gridColumnHint,
  gridColumnSortable,
  gridSortNext,
  gridSortOf,
  healthSentence,
  insightBreakdown,
  insightSourceRollups,
  opsGenericLine,
  opsStateCarriesAction,
  SKELETON_PULSE_HIGH,
  SKELETON_PULSE_LOW,
  SKELETON_PULSE_MS,
  SKELETON_ROWS,
  SKELETON_STAGGER_MS,
} from "./index";
import type { OpsState } from "./index";

describe(barStack, () => {
  it("stacks the two segments inside one column", () => {
    expect(barStack({ fail: 8, ok: 34 })).toStrictEqual({
      fail: 8,
      hasFail: true,
      ok: 34,
    });
  });

  it("truncates the good news rather than the failure when both cannot fit", () => {
    expect(barStack({ fail: 30, ok: 90 })).toStrictEqual({
      fail: 30,
      hasFail: true,
      ok: 70,
    });
  });

  it("reports an absent failed segment rather than a zero-height one", () => {
    expect(barStack({ fail: 0, ok: 40 })).toStrictEqual({
      fail: 0,
      hasFail: false,
      ok: 40,
    });
  });

  it("clamps values that arrived out of range rather than overflowing the plot", () => {
    expect(barStack({ fail: 140, ok: -5 })).toStrictEqual({
      fail: 100,
      hasFail: true,
      ok: 0,
    });
    expect(barStack({ fail: Number.NaN, ok: Number.NaN })).toStrictEqual({
      fail: 0,
      hasFail: false,
      ok: 0,
    });
  });
});

describe(barWindow, () => {
  it("draws the most recent columns when the series is longer than the chart", () => {
    const series = Array.from({ length: 30 }, (_unused, index) => index);
    expect(barWindow(series, 10)).toStrictEqual([
      20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    ]);
  });

  it("never pads a short series with empty days", () => {
    expect(barWindow([1], 10)).toStrictEqual([1]);
  });
});

describe(barShares, () => {
  it("scales the series against its own peak", () => {
    expect(barShares([0, 5, 10])).toStrictEqual([0, 50, 100]);
  });

  it("never draws a day that measured something as nothing", () => {
    // $0.004 against a $4 peak is 0.1% — below the rounding floor, and the
    // whole point of the chart is that it is not the same as a $0 day.
    expect(barShares([4, 0.004, 0])).toStrictEqual([100, 1, 0]);
  });

  it("draws an all-zero window flat rather than dividing by its peak", () => {
    expect(barShares([0, 0])).toStrictEqual([0, 0]);
    expect(barShares([Number.NaN, -3])).toStrictEqual([0, 0]);
  });
});

describe(dayFold, () => {
  const anchor = Date.UTC(2026, 5, 10, 12, 0, 0);
  const day = (offset: number): string =>
    new Date(anchor + offset * 86_400_000).toISOString().slice(0, 10);
  const points = [
    { costUsd: 0.1, date: day(-29), runs: 2 },
    { costUsd: 0.4, date: day(-1), runs: 5 },
    { costUsd: 0.2, date: day(0), runs: 3 },
  ];

  it("draws one column per day when the surface can fit them", () => {
    const buckets = dayFold(points, { anchor, columns: 30, windowDays: 30 });
    expect(buckets).toHaveLength(30);
    expect(buckets[0]?.date).toBe(day(-29));
    expect(buckets.at(-1)?.date).toBe(day(0));
    // The spike is its own column, which is the whole reason not to sample.
    expect(buckets.at(-2)?.costUsd).toBeCloseTo(0.4);
    expect(buckets.at(-1)?.runs).toBe(3);
  });

  it("folds by calendar offset, so a quiet week cannot slide the busy days", () => {
    const buckets = dayFold(points, { anchor, columns: 30, windowDays: 30 });
    expect(buckets[0]?.runs).toBe(2);
    expect(buckets[1]?.runs).toBe(0);
    expect(buckets.filter((b) => b.runs > 0)).toHaveLength(3);
  });

  it("states the span a bucket covers when a surface asked for fewer columns", () => {
    const buckets = dayFold(points, { anchor, columns: 10, windowDays: 30 });
    expect(buckets).toHaveLength(10);
    expect(buckets[0]?.fromDay).toBe(0);
    expect(buckets[0]?.toDay).toBe(2);
    expect(buckets[0]?.endDate).toBe(day(-27));
    expect(buckets.at(-1)?.runs).toBe(8);
  });

  it("never invents more columns than the window has days", () => {
    expect(
      dayFold(points, { anchor, columns: 30, windowDays: 7 })
    ).toHaveLength(7);
    expect(dayFold(points, { anchor, columns: 0, windowDays: 7 })).toHaveLength(
      1
    );
  });

  it("drops a day outside the window and an unparseable key rather than binning them", () => {
    const buckets = dayFold(
      [
        { costUsd: 9, date: day(-40), runs: 9 },
        { costUsd: 9, date: "not-a-day", runs: 9 },
      ],
      { anchor, columns: 7, windowDays: 7 }
    );
    expect(buckets.every((b) => b.runs === 0)).toBe(true);
  });
});

describe(dayMark, () => {
  it("names the month rather than numbering it", () => {
    expect(dayMark("2026-07-15")).toBe("15 Jul");
    expect(dayMark("2026-01-01")).toBe("1 Jan");
  });

  it("marks nothing for a key it cannot read", () => {
    expect(dayMark("")).toBe("");
    expect(dayMark("yesterday")).toBe("");
  });
});

describe(distributionRows, () => {
  it("leads with the biggest share and measures it against the whole", () => {
    const rows = distributionRows(DISTRIBUTION_FIXTURE);
    expect(rows.map((row) => row.id)).toStrictEqual([
      "claude-code",
      "codex",
      "gemini-cli",
    ]);
    // $2.50 of $3.404 is 73%, NOT the 100% a bar drawn against the maximum
    // would give the leading row.
    expect(rows.map((row) => row.share)).toStrictEqual([73, 26, 1]);
    expect(rows[0]?.value).toBe("$2.50 · 11k");
  });

  it("keeps the caller's order for an equal pair", () => {
    const rows = distributionRows([
      { id: "b", label: "b", value: "$1.00", weight: 1 },
      { id: "a", label: "a", value: "$1.00", weight: 1 },
    ]);
    expect(rows.map((row) => row.id)).toStrictEqual(["b", "a"]);
    expect(rows.map((row) => row.share)).toStrictEqual([50, 50]);
  });

  it("draws a window that cost nothing flat rather than dividing by zero", () => {
    const rows = distributionRows([
      { id: "a", label: "a", value: "$0.00", weight: 0 },
      { id: "b", label: "b", value: "$0.00", weight: Number.NaN },
    ]);
    expect(rows.map((row) => row.share)).toStrictEqual([0, 0]);
  });

  it("says nothing about an empty breakdown", () => {
    expect(distributionRows([])).toStrictEqual([]);
  });
});

describe(insightSourceRollups, () => {
  it("coalesces source kinds and measures shares across all runs", () => {
    expect(
      insightSourceRollups([
        { kind: "chat", runs: 3, costUsd: 2 },
        { kind: "automation", runs: 2, costUsd: 3 },
        { kind: "chat", runs: 1, costUsd: 1 },
        { kind: "build", runs: 0, costUsd: 4 },
      ])
    ).toStrictEqual([
      {
        bucket: "automations",
        runs: 2,
        costUsd: 3,
        sharePercent: 33,
      },
      {
        bucket: "the assistant",
        runs: 4,
        costUsd: 3,
        sharePercent: 67,
      },
      { bucket: "apps", runs: 0, costUsd: 4, sharePercent: 0 },
    ]);
  });

  it("omits absent buckets and leaves an all-zero denominator unspoken", () => {
    expect(
      insightSourceRollups([{ kind: "chat", runs: 0, costUsd: 1 }])
    ).toStrictEqual([
      { bucket: "the assistant", runs: 0, costUsd: 1, sharePercent: null },
    ]);
  });
});

describe(insightBreakdown, () => {
  const cost = (value: number): string => `$${value.toFixed(2)}`;
  const tokens = (value: number): string => `${value}t`;
  const runs = (value: number): string => `${value} runs`;

  it("uses spend as the denominator when any spend is known", () => {
    const result = insightBreakdown(
      [
        { id: "a", label: "A", costUsd: 2, tokens: 10, runs: 1 },
        { id: "b", label: "B", costUsd: 0, tokens: 20, runs: 2 },
      ],
      cost,
      tokens,
      runs
    );
    expect(result.meta).toBe("sorted by spend");
    expect(result.unit).toBe("of spend");
    expect(result.rows).toStrictEqual([
      {
        id: "a",
        label: "A",
        value: "$2.00 · 10t · 1 runs",
        weight: 2,
      },
      {
        id: "b",
        label: "B",
        value: "$0.00 · 20t · 2 runs",
        weight: 0,
      },
    ]);
  });

  it("falls back to tokens for an entirely unpriced breakdown", () => {
    expect(
      insightBreakdown(
        [{ id: "a", label: "A", costUsd: 0, tokens: 20, runs: 2 }],
        cost,
        tokens,
        runs
      )
    ).toMatchObject({ meta: "sorted by tokens", unit: "of tokens" });
  });
});

describe(boneWidths, () => {
  it("steps the standard six from 66% down to 36%", () => {
    expect(boneWidths(SKELETON_ROWS)).toStrictEqual([66, 60, 54, 48, 42, 36]);
  });

  it("floors the width rather than stepping into negative bones", () => {
    expect(boneWidths(12).at(-1)).toBe(24);
    expect(boneWidths(0)).toStrictEqual([]);
    expect(boneWidths(-3)).toStrictEqual([]);
  });

  it("breathes on a stagger rather than blinking as one block", () => {
    expect(boneDelay(0)).toBe(0);
    expect(boneDelay(3)).toBe(SKELETON_STAGGER_MS * 3);
    expect(SKELETON_PULSE_MS).toBe(1600);
    expect(SKELETON_PULSE_HIGH).toBeGreaterThan(SKELETON_PULSE_LOW);
  });
});

describe(docSnipLine, () => {
  it("joins the two hidden columns", () => {
    expect(docSnipLine("pdf", "12 Aug 2026")).toBe("pdf · 12 Aug 2026");
  });

  it("renders no stray separator when a half is missing", () => {
    expect(docSnipLine("", "12 Aug 2026")).toBe("12 Aug 2026");
    expect(docSnipLine("pdf", "")).toBe("pdf");
    expect(docSnipLine("", "")).toBe("");
  });
});

describe(docRowMenu, () => {
  const labels = {
    copyId: "Copy the id",
    delete: "Delete",
    edit: "Edit",
    open: "Open the record",
  };

  it("holds the destructive verb in its own group", () => {
    const menu = docRowMenu(labels);
    expect(menu.record.map((item) => item.action)).toStrictEqual([
      "open",
      "edit",
      "copyId",
    ]);
    expect(menu.danger).toStrictEqual([{ action: "delete", label: "Delete" }]);
  });

  it("omits a verb the caller cannot honour rather than listing it", () => {
    const menu = docRowMenu({ copyId: labels.copyId, open: labels.open });
    expect(menu.record.map((item) => item.action)).toStrictEqual([
      "open",
      "copyId",
    ]);
    expect(menu.danger).toStrictEqual([]);
  });
});

describe(opsGenericLine, () => {
  const lines = {
    empty: "Nothing to attend to",
    error: "This page could not load",
    loading: "Reading from the gateway",
  };

  it("speaks for the three states that read the same on every surface", () => {
    expect(opsGenericLine("loading", lines)).toBe(lines.loading);
    expect(opsGenericLine("empty", lines)).toBe(lines.empty);
    expect(opsGenericLine("error", lines)).toBe(lines.error);
  });

  it("leaves the settled states to the surface's own words", () => {
    expect(opsGenericLine("ready", lines)).toBeUndefined();
    expect(opsGenericLine("full", lines)).toBeUndefined();
  });
});

describe(opsStateCarriesAction, () => {
  it("publishes a verb in ready and full only", () => {
    expect(opsStateCarriesAction("ready")).toBe(true);
    expect(opsStateCarriesAction("full")).toBe(true);
    for (const state of ["empty", "loading", "error"] satisfies OpsState[]) {
      expect(opsStateCarriesAction(state)).toBe(false);
    }
  });
});

describe(healthSentence, () => {
  it("joins the standing fact to its qualifier", () => {
    expect(healthSentence("3 waiting on you", "Approving is the act.")).toBe(
      "3 waiting on you · Approving is the act."
    );
    expect(healthSentence("", "Only the detail.")).toBe("Only the detail.");
    expect(healthSentence("Only the label.", "")).toBe("Only the label.");
  });
});

describe(gridCell, () => {
  it("keeps a null and a blank apart — only one of them is a gap", () => {
    expect(gridCell(null).kind).toBe("null");
    expect(gridCell(undefined).kind).toBe("null");
    expect(gridCell("").kind).toBe("blank");
    expect(gridCell(0).kind).toBe("value");
    expect(gridCell(false).kind).toBe("value");
  });

  it("refuses a sealed cell any text at all, absent value or not", () => {
    expect(gridCell("«sealed»", { sealed: true })).toStrictEqual({
      clipped: false,
      kind: "sealed",
      short: "",
      text: "",
    });
    expect(gridCell(null, { sealed: true }).kind).toBe("sealed");
  });

  it("shows an object as the JSON the store holds", () => {
    expect(gridCell({ a: 1 }).text).toBe('{"a":1}');
  });

  it("cuts a long value reversibly and leaves a short one whole", () => {
    const long = "x".repeat(GRID_CLIP_AT + 1);
    const cut = gridCell(long);
    expect(cut.clipped).toBe(true);
    expect(cut.text).toBe(long);
    expect(cut.short).toBe(`${"x".repeat(GRID_CLIP_AT)}…`);

    const whole = gridCell("x".repeat(GRID_CLIP_AT));
    expect(whole.clipped).toBe(false);
    expect(whole.short).toBe(whole.text);
  });

  it("takes a caller's own clip point", () => {
    expect(gridCell("abcdef", { clipAt: 3 }).short).toBe("abc…");
  });
});

describe(gridSortNext, () => {
  it("opens ascending and only turns the SAME column round", () => {
    expect(gridSortNext(null, "name")).toStrictEqual({
      dir: "asc",
      key: "name",
    });
    expect(gridSortNext({ dir: "asc", key: "name" }, "name")).toStrictEqual({
      dir: "desc",
      key: "name",
    });
    expect(gridSortNext({ dir: "desc", key: "name" }, "name")).toStrictEqual({
      dir: "asc",
      key: "name",
    });
  });

  it("never carries another column's direction across", () => {
    expect(gridSortNext({ dir: "desc", key: "at" }, "name")).toStrictEqual({
      dir: "asc",
      key: "name",
    });
  });
});

describe(gridSortOf, () => {
  it("answers only for the column the grid is ordered by", () => {
    expect(gridSortOf({ dir: "desc", key: "at" }, "at")).toBe("desc");
    expect(gridSortOf({ dir: "desc", key: "at" }, "name")).toBeNull();
    expect(gridSortOf(null, "at")).toBeNull();
  });
});

describe(gridColumnBadges, () => {
  it("states the key badges in reference order and none otherwise", () => {
    expect(
      gridColumnBadges({ fk: "core.place", key: "k", label: "k", pk: true })
    ).toStrictEqual(["pk", "fk"]);
    expect(gridColumnBadges({ key: "k", label: "k" })).toStrictEqual([]);
  });
});

describe(gridColumnHint, () => {
  it("names what a reference points at, and says nothing when there is none", () => {
    expect(gridColumnHint({ fk: "core.place", key: "k", label: "k" })).toBe(
      "→ core.place"
    );
    expect(gridColumnHint({ key: "k", label: "k" })).toBeUndefined();
  });
});

describe(gridColumnSortable, () => {
  it("makes a header a control unless the store cannot order by it", () => {
    expect(gridColumnSortable({ key: "k", label: "k" })).toBe(true);
    expect(gridColumnSortable({ fixed: true, key: "k", label: "k" })).toBe(
      false
    );
  });
});
