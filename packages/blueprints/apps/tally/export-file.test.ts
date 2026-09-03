import { describe, expect, it } from "vitest";

import { exportFile } from "./export-file.ts";
import { rangeSince } from "./export-read.ts";
import type { ExportData } from "./types.ts";

const DATA: ExportData = {
  group: {
    group_id: "flat",
    name: "14 Sitwell Road",
    archived_at: null,
    members: [{ party_id: "me", name: "You" }],
  },
  currency: "GBP",
  expenses: [
    {
      expense_id: "x1",
      description: 'Dinner, "the Ship"',
      amount_minor: 10_000,
      split_method: "equally",
    },
  ],
  settlements: [{ from_party: "ana", to_party: "me", amount_minor: 4560 }],
  revisions: [{ revision_id: "r1", expense_id: "x1", operation: "update" }],
  balances_excluded: true,
  truncated: false,
  window: { limit: 500, since: null, expenses: 1, settlements: 1 },
};

describe("the file, assembled on the device", () => {
  it("names itself after the group, in the chosen format", () => {
    expect(exportFile(DATA, "csv").name).toBe("14-sitwell-road.csv");
    expect(exportFile(DATA, "json").name).toBe("14-sitwell-road.json");
  });

  it("keeps the three shapes as three tables rather than one flattened row", () => {
    const text = exportFile(DATA, "csv").text;
    expect(text).toContain("# expenses");
    expect(text).toContain("# settlements");
    expect(text).toContain("# revisions");
  });

  it("quotes a cell that carries a comma or a quote of its own", () => {
    expect(exportFile(DATA, "csv").text).toContain('"Dinner, ""the Ship"""');
  });

  it("carries no balance, and says the exclusion out loud", () => {
    const json = JSON.parse(exportFile(DATA, "json").text) as ExportData;
    expect(json.balances_excluded).toBe(true);
    expect(json).not.toHaveProperty("owe_total_minor");
    expect(json).not.toHaveProperty("owed_total_minor");
  });

  it("falls back to a nameable file where the group has no name", () => {
    expect(exportFile({ ...DATA, group: null }, "csv").name).toBe("ledger.csv");
  });

  it("carries the window it was bounded to, so a month is not read as a whole", () => {
    const bounded: ExportData = {
      ...DATA,
      window: { limit: 500, since: "2026-08-01", expenses: 1, settlements: 1 },
    };
    const json = JSON.parse(exportFile(bounded, "json").text) as ExportData;
    expect(json.window.since).toBe("2026-08-01");
  });
});

describe("the Range chip, as the query's floor", () => {
  const NOW = new Date(2026, 7, 26, 12, 0, 0); // 26 August 2026, local

  it("asks for no floor at all when the chip says Everything", () => {
    expect(rangeSince("all", NOW)).toBeNull();
  });

  it("floors at January the first for this year", () => {
    expect(rangeSince("year", NOW)).toBe("2026-01-01");
  });

  it("floors at the first of the month for this month", () => {
    expect(rangeSince("month", NOW)).toBe("2026-08-01");
  });

  it("pads a single-digit month rather than naming an unparseable date", () => {
    expect(rangeSince("month", new Date(2026, 0, 9, 12, 0, 0))).toBe(
      "2026-01-01"
    );
  });

  it("narrows nothing for a chip it has never heard of", () => {
    expect(rangeSince("decade", NOW)).toBeNull();
  });
});
