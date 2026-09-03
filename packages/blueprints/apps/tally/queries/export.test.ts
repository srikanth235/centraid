// THE EXPORT WINDOW, AND THE RANGE THAT BOUNDS IT.
//
// The Range chip used to be decoration: the surface named a month and the file
// carried the whole ledger anyway. These cases pin the honest version — what
// `since` excludes, what it keeps, and that the counts the foot reads describe
// the range rather than the group.
import { describe, expect, it, vi } from "vitest";

import exportHandler from "./export.ts";

const ROWS: Record<string, Array<Record<string, unknown>>> = {
  "core.vault": [{ self_party_id: "party-owner", base_currency: "GBP" }],
  "tally.friend": [{ party_id: "party-ana" }],
  "tally.group": [{ group_id: "group-flat", circle_id: "circle-flat" }],
  "social.circle": [{ circle_id: "circle-flat", name: "14 Sitwell Road" }],
  "social.circle_member": [
    { circle_id: "circle-flat", party_id: "party-owner" },
    { circle_id: "circle-flat", party_id: "party-ana" },
  ],
  "tally.expense": [
    {
      expense_id: "expense-this-month",
      group_id: "group-flat",
      paid_by: "party-owner",
      amount_minor: 2000,
      description: "Groceries",
      category: "groceries",
      spent_on: "2026-08-04",
    },
    {
      expense_id: "expense-earlier-this-year",
      group_id: "group-flat",
      paid_by: "party-ana",
      amount_minor: 3000,
      description: "Boiler",
      category: "utilities",
      spent_on: "2026-03-11",
    },
    {
      expense_id: "expense-last-year",
      group_id: "group-flat",
      paid_by: "party-owner",
      amount_minor: 4000,
      description: "Sofa",
      category: "shopping",
      spent_on: "2025-11-02",
    },
  ],
  "tally.expense_split": [
    {
      expense_id: "expense-this-month",
      party_id: "party-owner",
      share_minor: 1000,
    },
    {
      expense_id: "expense-this-month",
      party_id: "party-ana",
      share_minor: 1000,
    },
  ],
  "tally.settlement": [
    {
      settlement_id: "settlement-this-month",
      group_id: "group-flat",
      from_party: "party-ana",
      to_party: "party-owner",
      amount_minor: 1000,
      paid_on: "2026-08-10",
    },
    {
      settlement_id: "settlement-last-year",
      group_id: "group-flat",
      from_party: "party-owner",
      to_party: "party-ana",
      amount_minor: 500,
      paid_on: "2025-12-30",
    },
  ],
  "core.entity_revision": [
    {
      revision_id: "revision-of-in-range",
      entity_id: "expense-this-month",
      operation: "update",
      recorded_at: "2026-08-05T09:00:00.000Z",
    },
    {
      revision_id: "revision-of-out-of-range",
      entity_id: "expense-last-year",
      operation: "update",
      recorded_at: "2026-08-05T09:00:00.000Z",
    },
  ],
  "core.party": [
    { party_id: "party-owner", display_name: "You" },
    { party_id: "party-ana", display_name: "Ana" },
  ],
};

function run(input: Record<string, unknown>) {
  const read = vi.fn<
    (request: { entity: string }) => Promise<{
      rows: Array<Record<string, unknown>>;
    }>
  >(async ({ entity }) => ({ rows: ROWS[entity] ?? [] }));
  return exportHandler({
    input,
    ctx: { vault: { read } },
  } as unknown as HandlerArgs);
}

const ids = (rows: Record<string, unknown>[], key: string): unknown[] =>
  rows.map((row) => row[key]);

describe("Tally export, ranged", () => {
  it("carries the whole bounded window when no floor is asked for", async () => {
    const result = await run({ group_id: "group-flat" });

    expect(ids(result.expenses, "expense_id")).toStrictEqual([
      "expense-this-month",
      "expense-earlier-this-year",
      "expense-last-year",
    ]);
    expect(result.settlements).toHaveLength(2);
    expect(result.window).toStrictEqual({
      limit: 500,
      since: null,
      expenses: 3,
      settlements: 2,
    });
  });

  it("keeps only the rows dated on or after the floor, by each row's own date", async () => {
    const result = await run({ group_id: "group-flat", since: "2026-08-01" });

    expect(ids(result.expenses, "expense_id")).toStrictEqual([
      "expense-this-month",
    ]);
    expect(ids(result.settlements, "paid_on")).toStrictEqual(["2026-08-10"]);
  });

  it("counts the range, not the group, so the foot states what the file holds", async () => {
    const result = await run({ group_id: "group-flat", since: "2026-01-01" });

    expect(result.window).toStrictEqual({
      limit: 500,
      since: "2026-01-01",
      expenses: 2,
      settlements: 1,
    });
    expect(result.truncated).toBe(false);
    expect(result.balances_excluded).toBe(true);
  });

  it("takes the floor inclusively — a row dated the boundary day travels", async () => {
    const result = await run({ group_id: "group-flat", since: "2026-08-04" });

    expect(ids(result.expenses, "expense_id")).toStrictEqual([
      "expense-this-month",
    ]);
  });

  it("ships only the revisions of the expenses that travel", async () => {
    const whole = await run({ group_id: "group-flat" });
    expect(ids(whole.revisions, "revision_id")).toStrictEqual([
      "revision-of-in-range",
      "revision-of-out-of-range",
    ]);

    const ranged = await run({ group_id: "group-flat", since: "2026-08-01" });
    expect(ids(ranged.revisions, "revision_id")).toStrictEqual([
      "revision-of-in-range",
    ]);
  });

  it("truncates against the range it was given", async () => {
    const result = await run({
      group_id: "group-flat",
      since: "2026-01-01",
      limit: 1,
    });

    expect(result.expenses).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.window.expenses).toBe(2);
  });

  it("treats a floor it cannot read as no floor, rather than narrowing quietly", async () => {
    const result = await run({ group_id: "group-flat", since: "last August" });

    expect(result.window.since).toBeNull();
    expect(result.expenses).toHaveLength(3);
  });

  it("states the range on the window even where the group is unknown", async () => {
    const result = await run({
      group_id: "group-nowhere",
      since: "2026-08-01",
    });

    expect(result.group).toBeNull();
    expect(result.window).toStrictEqual({
      limit: 500,
      since: "2026-08-01",
      expenses: 0,
      settlements: 0,
    });
  });
});
