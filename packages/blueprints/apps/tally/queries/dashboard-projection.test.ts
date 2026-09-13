// THE PROJECTION IS PART OF THE ANSWER (#1020, D-1020-CL3).
//
// `pagedFixture` hands a handler whole fixture rows whatever its statement
// selected, which is exactly the blind spot that let `tally.dashboard.expenses`
// omit eight columns `ledgerRow` reads and stay green for a year. So this file
// narrows every fixture row to the statement's own select list before the
// handler sees it — the paged door's real behaviour, where an unselected column
// reads as `undefined` rather than throwing — and then asks the member's
// question: what currency does the dashboard say a Tokyo dinner was in?

import { describe, expect, it } from "vitest";

import type { PagedStatement } from "../../_shared/paged-ctx.test-fixtures.ts";
import { pagedFixture } from "../../_shared/paged-ctx.test-fixtures.ts";
import dashboardHandler from "./dashboard.ts";

const ROWS: Record<string, Array<Record<string, unknown>>> = {
  "core.vault": [
    {
      vault_id: "vault-1",
      self_party_id: "party-owner",
      base_currency: "GBP",
    },
  ],
  "core.party": [
    { party_id: "party-owner", display_name: "You" },
    { party_id: "party-ana", display_name: "Ana" },
  ],
  "tally.friend": [
    {
      friend_id: "friend-ana",
      party_id: "party-ana",
      created_at: "2026-01-01",
    },
  ],
  "tally.expense": [
    {
      expense_id: "expense-tokyo",
      group_id: null,
      description: "Dinner in Tokyo",
      amount_minor: 5200,
      currency: "GBP",
      paid_by: "party-owner",
      split_method: "equally",
      split_params_json: null,
      spent_on: "2026-07-02",
      category: "food",
      txn_id: null,
      created_at: "2026-07-02T12:00:00.000Z",
      updated_at: "2026-07-02T12:00:00.000Z",
      // What the member actually spent, and the rate they were told: ¥9,800
      // that settles as £52.00 at 0.005306 GBP to the yen.
      original_amount_minor: 980_000,
      original_currency: "JPY",
      settlement_currency: "GBP",
      rate_scaled: 5_306,
      rate_scale: 6,
      rate_source: "supplied at entry",
      rate_date: "2026-07-02",
      recurring_template_id: null,
    },
  ],
  "tally.expense_split": [
    {
      expense_id: "expense-tokyo",
      party_id: "party-owner",
      share_minor: 2600,
    },
    { expense_id: "expense-tokyo", party_id: "party-ana", share_minor: 2600 },
  ],
  "tally.expense_payer": [
    { expense_id: "expense-tokyo", party_id: "party-owner", paid_minor: 5200 },
  ],
};

/** The columns a statement asked for, as the door would return them. */
function projected(
  row: Record<string, unknown>,
  statement: PagedStatement
): Record<string, unknown> {
  const wanted = statement.select.split(",").map((column) => column.trim());
  const kept: Record<string, unknown> = {};
  for (const column of wanted) if (column in row) kept[column] = row[column];
  return kept;
}

function run() {
  const fixture = pagedFixture(ROWS);
  return dashboardHandler({
    input: {},
    ctx: {
      vault: {
        page: async (request: {
          query: PagedStatement;
          limit: number;
          after?: { sortKey: string; pk: string };
        }) => {
          const answer = await fixture.page(request);
          return {
            ...answer,
            rows: answer.rows.map((row) => projected(row, request.query)),
          };
        },
      },
      time: { describeRecurrence: () => "" },
    },
  } as never) as Promise<{
    currency: string;
    rate_suggestions: { from_currency: string; to_currency: string }[];
  }>;
}

describe("the dashboard's expense projection", () => {
  it("labels a foreign-currency expense in the money it was settled in", async () => {
    const result = (await run()) as unknown as {
      currency: string;
      rate_suggestions: Record<string, unknown>[];
    };

    expect(result.currency).toBe("GBP");
    // The vault's base money is GBP and the dinner was paid in yen. With the
    // eight columns unselected every one of them read `undefined`, so
    // `original_currency` and `settlement_currency` were both the base money,
    // `from === to`, and the vault could never quote itself a rate it had
    // already been told.
    expect(result.rate_suggestions).toStrictEqual([
      {
        from_currency: "JPY",
        to_currency: "GBP",
        rate_scaled: 5_306,
        rate_scale: 6,
        rate_source: "supplied at entry",
        rate_date: "2026-07-02",
        observed_on: "2026-07-02",
        expense_id: "expense-tokyo",
      },
    ]);
  });
});
