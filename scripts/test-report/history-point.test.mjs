import { describe, expect, test } from "vitest";

import { historyPoint } from "./history-point.mjs";

/**
 * #535 / #839 Wave 5 — the durable-history read boundary.
 *
 * The gh-pages series carries whole `summary.json` files from every night this
 * report has ever run, including nights that predate every field added since.
 * The two properties under test are the ones that make reading it safe: a
 * field NOT on the whitelist never reaches the report, and a field that is on
 * it but absent reads as null/empty rather than as a flattering zero.
 */
describe("historyPoint", () => {
  test("an unknown field never crosses the boundary", () => {
    const point = historyPoint({ label: "n", cellsMissing: 3, smuggled: 99 });
    expect(point).not.toHaveProperty("smuggled");
    expect(point.cellsMissing).toBe(3);
  });

  test("an absent measurement is null, never zero", () => {
    const point = historyPoint({ label: "n" });
    expect(point.passed).toBeNull();
    expect(point.cellsFailed).toBeNull();
    expect(point.missingCellIds).toStrictEqual([]);
    expect(point.floorSeries).toStrictEqual({});
  });

  test("a non-numeric measurement is null, not NaN", () => {
    expect(historyPoint({ label: "n", passed: "many" }).passed).toBeNull();
    expect(historyPoint({ label: "n", passed: "" }).passed).toBeNull();
    expect(historyPoint({ label: "n", passed: "12" }).passed).toBe(12);
  });

  test("a malformed array or record is coerced to empty, not carried", () => {
    const point = historyPoint({
      label: "n",
      missingCellIds: "a,b",
      floorSeries: ["not", "a", "record"],
      laneSeries: null,
    });
    expect(point.missingCellIds).toStrictEqual([]);
    expect(point.floorSeries).toStrictEqual({});
    expect(point.laneSeries).toStrictEqual({});
  });

  describe("the #839 Wave 5 additions", () => {
    test("the verdict rides the series as a string, or null", () => {
      expect(historyPoint({ label: "n", verdict: "degraded" }).verdict).toBe(
        "degraded"
      );
      expect(historyPoint({ label: "n" }).verdict).toBeNull();
      expect(historyPoint({ label: "n", verdict: 3 }).verdict).toBeNull();
      expect(historyPoint({ label: "n", verdict: "" }).verdict).toBeNull();
    });

    test("app-axis and adversary counts arrive as records of finite numbers", () => {
      const point = historyPoint({
        label: "n",
        appSeatCells: { declared: 12, unowned: 9, skipped: 3 },
        appStateCells: { declared: 4 },
        adversaryCounts: { mutationSeeds: 24, fuzzTargets: 6 },
      });
      expect(point.appSeatCells).toStrictEqual({
        declared: 12,
        unowned: 9,
        skipped: 3,
      });
      expect(point.appStateCells).toStrictEqual({ declared: 4 });
      expect(point.adversaryCounts).toStrictEqual({
        mutationSeeds: 24,
        fuzzTargets: 6,
      });
    });

    test("a night recorded before this wave reads empty, never zeroed", () => {
      const point = historyPoint({ label: "2026-07-01", cellsMissing: 0 });
      expect(point.appSeatCells).toStrictEqual({});
      expect(point.appStateCells).toStrictEqual({});
      expect(point.adversaryCounts).toStrictEqual({});
    });

    test("a non-numeric count is dropped rather than smuggled through", () => {
      expect(
        historyPoint({
          label: "n",
          adversaryCounts: { mutationSeeds: "lots", fuzzTargets: 6 },
        }).adversaryCounts
      ).toStrictEqual({ fuzzTargets: 6 });
      expect(
        historyPoint({ label: "n", appSeatCells: "declared" }).appSeatCells
      ).toStrictEqual({});
    });
  });
});
