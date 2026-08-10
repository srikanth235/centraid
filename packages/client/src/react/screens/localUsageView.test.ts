import { describe, expect, it } from "vitest";

import type {
  LocalComponentId,
  LocalUsageReportDTO,
} from "../../gateway-client-local-storage.js";
import {
  budgetSummary,
  footprintScale,
  footprintSlices,
  formatBytes,
  parseBytes,
  presentationFor,
} from "./localUsageView.js";

// The Storage page's presentation derivation (issue #544). Every assertion
// here is about a claim the UI makes to the owner, so a wrong one is a lie on
// screen rather than a cosmetic slip.

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** A component id the wire sent that this build's `LocalComponentId` union
 *  does not name — what a newer gateway can do, since the union is a
 *  compile-time-only guarantee over what is really just a JSON string. */
const unknown = (id: string): LocalComponentId =>
  id as unknown as LocalComponentId;

function report(over: Partial<LocalUsageReportDTO> = {}): LocalUsageReportDTO {
  return {
    scannedAt: 0,
    totalBytes: 10 * GB,
    components: [{ component: "logs", bytes: GB, files: 3 }],
    vaults: [
      {
        vaultId: "a",
        bytes: 6 * GB,
        components: [
          { component: "attachments", bytes: 5 * GB, files: 100 },
          { component: "ledger", bytes: GB, files: null },
        ],
      },
      {
        vaultId: "b",
        bytes: 3 * GB,
        components: [
          { component: "attachments", bytes: 2 * GB, files: 40 },
          { component: "ledger", bytes: GB, files: null },
        ],
      },
    ],
    disk: { freeBytes: 40 * GB, totalBytes: 500 * GB },
    limits: {
      totalLimitBytes: null,
      warnAtPercent: 80,
      journalLimitBytes: null,
    },
    limit: {
      status: "ok",
      fractionUsed: null,
      usedBytes: 10 * GB,
      limitBytes: null,
    },
    ...over,
  };
}

describe(footprintSlices, () => {
  it("folds per-vault and gateway-level components into one legend, largest first", () => {
    const slices = footprintSlices(report());
    expect(slices.map((s) => s.component)).toStrictEqual([
      "attachments",
      "ledger",
      "logs",
    ]);
    // Attachments sums across BOTH vaults; logs is gateway-level.
    expect(slices[0]!.bytes).toBe(7 * GB);
    expect(slices[1]!.bytes).toBe(2 * GB);
    expect(slices[2]!.bytes).toBe(GB);
  });

  it("reports each slice as a share of the reported total", () => {
    const slices = footprintSlices(report());
    expect(slices[0]!.fraction).toBeCloseTo(0.7, 5);
    const sum = slices.reduce((acc, s) => acc + s.fraction, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('drops zero-byte components — a permanent "0 B" row is noise', () => {
    const slices = footprintSlices(
      report({ components: [{ component: "templates", bytes: 0, files: 0 }] })
    );
    expect(slices.some((s) => s.component === "templates")).toBe(false);
  });

  it("carries an unreadable note through so the figure reads as a floor", () => {
    const slices = footprintSlices(
      report({
        components: [
          { component: "logs", bytes: GB, files: 3, unreadable: "/x: EACCES" },
        ],
      })
    );
    expect(slices.find((s) => s.component === "logs")?.unreadable).toBe(
      "/x: EACCES"
    );
  });

  it("does not divide by zero on an empty gateway", () => {
    const slices = footprintSlices(
      report({ totalBytes: 0, components: [], vaults: [] })
    );
    expect(slices).toStrictEqual([]);
  });

  it("degrades an id this build does not recognize to an honest generic label instead of throwing — issue #726 finding 4", () => {
    const slices = footprintSlices(
      report({
        components: [
          { component: unknown("not-yet-invented"), bytes: GB, files: 1 },
        ],
      })
    );
    const found = slices.find(
      (s) => s.component === unknown("not-yet-invented")
    );
    expect(found).toBeDefined();
    expect(found?.label).toBe("not-yet-invented");
    expect(found?.bytes).toBe(GB);
  });

  it("keeps a component on its own hue regardless of rank", () => {
    const big = footprintSlices(report());
    const flipped = footprintSlices(
      report({
        components: [{ component: "logs", bytes: 100 * GB, files: 3 }],
        totalBytes: 109 * GB,
      })
    );
    const hue = (
      slices: ReturnType<typeof footprintSlices>,
      id: string
    ): string | undefined => slices.find((s) => s.component === id)?.color;
    expect(hue(flipped, "logs")).toBe(hue(big, "logs"));
    expect(flipped[0]!.component).toBe("logs");
  });
});

describe(presentationFor, () => {
  it("answers the fixed presentation for a known id", () => {
    expect(presentationFor("logs")).toMatchObject({
      label: "Logs",
    });
  });

  it("never throws for an id outside the known vocabulary — degrades to the raw id as its own label", () => {
    expect(() => presentationFor("future-component")).not.toThrow();
    expect(presentationFor("future-component")).toMatchObject({
      label: "future-component",
      color: "var(--c-slate)",
    });
  });
});

describe(footprintScale, () => {
  it("measures against the owner’s budget when they set one", () => {
    const scale = footprintScale(
      report({
        limits: {
          totalLimitBytes: 20 * GB,
          warnAtPercent: 75,
          journalLimitBytes: null,
        },
      })
    );
    expect(scale).toMatchObject({
      kind: "budget",
      againstBytes: 20 * GB,
      over: false,
    });
    expect(scale.fillFraction).toBeCloseTo(0.5, 5);
    expect(scale.warnFraction).toBeCloseTo(0.75, 5);
  });

  it("clamps an over-budget fill so the bar stays in its box, and flags it", () => {
    const scale = footprintScale(
      report({
        limits: {
          totalLimitBytes: 5 * GB,
          warnAtPercent: 80,
          journalLimitBytes: null,
        },
      })
    );
    expect(scale.fillFraction).toBe(1);
    expect(scale.over).toBe(true);
  });

  it("falls back to the disk TOTAL, never to free space", () => {
    const scale = footprintScale(report());
    // Free space moves whenever anything else on the machine writes; total
    // is a stable denominator.
    expect(scale).toMatchObject({ kind: "disk", againstBytes: 500 * GB });
  });

  it("invents no denominator when there is nothing to scale against", () => {
    expect(footprintScale(report({ disk: null }))).toMatchObject({
      kind: "none",
      againstBytes: null,
      fillFraction: 0,
    });
  });
});

describe("formatBytes / parseBytes", () => {
  it("round-trips the units the limit inputs accept", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(30 * GB)).toBe("30.0 GB");
    expect(parseBytes("30 GB")).toBe(30 * GB);
    expect(parseBytes("512mb")).toBe(512 * MB);
    expect(parseBytes("  2  ")).toBe(2 * GB); // bare numbers default to GB
    expect(parseBytes(formatBytes(30 * GB))).toBe(30 * GB);
  });

  it("refuses rather than guessing", () => {
    for (const bad of ["", "lots", "-4 GB", "0", "12 parsecs"]) {
      expect(parseBytes(bad)).toBeNull();
    }
  });
});

describe(budgetSummary, () => {
  it("says nothing is blocked when over budget", () => {
    const over = report({
      limits: {
        totalLimitBytes: 5 * GB,
        warnAtPercent: 80,
        journalLimitBytes: null,
      },
      limit: {
        status: "error",
        fractionUsed: 2,
        usedBytes: 10 * GB,
        limitBytes: 5 * GB,
      },
    });
    expect(budgetSummary(over, over.limits)).toContain(
      "Nothing is being blocked"
    );
  });

  it("names the warn threshold when past it", () => {
    const warn = report({
      limits: {
        totalLimitBytes: 12 * GB,
        warnAtPercent: 80,
        journalLimitBytes: null,
      },
      limit: {
        status: "degraded",
        fractionUsed: 0.83,
        usedBytes: 10 * GB,
        limitBytes: 12 * GB,
      },
    });
    expect(budgetSummary(warn, warn.limits)).toContain("80%");
  });

  it("offers the disk as context when no budget is set", () => {
    const r = report();
    expect(budgetSummary(r, r.limits)).toContain("40.0 GB free");
  });
});
