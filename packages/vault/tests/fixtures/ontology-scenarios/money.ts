// MONEY — the scenario wave 0d landed (#996, drift ONT-23).
//
// A EUR 100 debt and a USD 100 debt are not a 200 of anything. The fold reads
// the ledger the way `pairwise` and the Tally dashboard read it — per party AND
// per currency — and the single hero figure is a `Valuation`, which is
// `unavailable` when the position spans currencies and no rate source exists.
// There is no rate plane in the product, and inventing one was the defect.

import { moneyBag, valuate } from "@centraid/core/money";
import type { Money } from "@centraid/core/money";

import type {
  ScenarioCheck,
  ScenarioContext,
  ScenarioDefinition,
} from "./types.js";

interface LedgerRow {
  currency: string;
  paid_minor: number;
  share_minor: number;
}

/** What the owner is owed, per currency: paid minus own share, folded per
 *  currency and never across. This is the shape `pairwise` answers in. */
function ownerPosition(ctx: ScenarioContext): readonly Money[] {
  const rows = ctx.rows<LedgerRow>(
    `SELECT e.currency,
            COALESCE((SELECT p.paid_minor FROM tally_expense_payer p
                       WHERE p.expense_id = e.expense_id AND p.party_id = ?), 0) AS paid_minor,
            COALESCE((SELECT s.share_minor FROM tally_expense_split s
                       WHERE s.expense_id = e.expense_id AND s.party_id = ?), 0) AS share_minor
       FROM tally_expense e
      WHERE e.deleted_at IS NULL`,
    ctx.boot.ownerPartyId,
    ctx.boot.ownerPartyId
  );
  return moneyBag(
    ...rows.map((row) => ({
      amount_minor: row.paid_minor - row.share_minor,
      currency: row.currency,
    }))
  );
}

export const MONEY_SCENARIOS: readonly ScenarioDefinition[] = [
  {
    id: "ONT-23/two-currencies-are-two-balances",
    drift: "ONT-23",
    title: "USD 100 + EUR 100 is two balances, and nothing is 200",
    surfaces: ["Tally — the dashboard hero", "Tally — the group ledger"],
    run(ctx): ScenarioCheck[] {
      const friend = ctx.execute<{ party_id: string }>("tally.add_friend", {
        name: "Priya",
      }).party_id;
      const group = (name: string, currency: string): string =>
        ctx.execute<{ group_id: string }>("tally.create_group", {
          name,
          icon: "🏠",
          currency,
          member_ids: [friend],
        }).group_id;
      const spend = (groupId: string, description: string): void => {
        ctx.execute("tally.add_expense", {
          group_id: groupId,
          description,
          amount_minor: 10_000,
          paid_by: ctx.boot.ownerPartyId,
          category: "food",
          splits: [
            { party_id: ctx.boot.ownerPartyId, share_minor: 5_000 },
            { party_id: friend, share_minor: 5_000 },
          ],
        });
      };
      spend(group("Home", "USD"), "Dinner in dollars");
      spend(group("Trip", "EUR"), "Dinner in euro");

      const position = ownerPosition(ctx);
      // The vault's base currency, and no rate source anywhere in the product.
      const hero = valuate(position, "USD");
      return [
        {
          claim: "the position is two balances, one per currency",
          actual: position,
          expected: [
            { amount_minor: 5_000, currency: "EUR" },
            { amount_minor: 5_000, currency: "USD" },
          ],
        },
        {
          claim: "the single hero figure is unavailable, not a sum",
          actual: hero.state,
          expected: "unavailable",
        },
        {
          claim: "and it names the components rather than adding them",
          actual: hero.components,
          expected: position,
        },
      ];
    },
  },
];
