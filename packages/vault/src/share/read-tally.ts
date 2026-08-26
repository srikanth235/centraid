// The origin-side read of a Tally group (#726 split of household.ts).
//
// A Tally group is the one shareable item that is a LEDGER rather than a
// document: it only means anything alongside its circle, its accounting
// parties and every expense/split/settlement that balances it. So the whole
// sub-graph crosses, and — unlike a photograph's `creator_party_id` — the
// party rows DO come with it: a balance naming a party the audience has never
// heard of is not a privacy win, it is a broken ledger. They cross as
// ACCOUNTING parties (core_party rows), never as principals; nothing here
// touches consent, membership or identity.
//
// Receipt bytes ride the closure's shared content pool (read-closure.ts), so a
// receipt photographed once and also shared on its own crosses once.

import type { DatabaseSync } from "node:sqlite";

import { VaultShareError } from "../errors.js";
import type { WireRow, WireTallyGroup } from "./closure.js";
import { one, rows } from "./sql.js";

/**
 * Read one group's ledger. `poolContent` is the closure's content pool: it
 * returns false when a receipt's content item is gone from the origin, and
 * that receipt is then projected without bytes rather than failing the share.
 */
export function readTallyGroup(
  origin: DatabaseSync,
  itemId: string,
  poolContent: (contentId: string) => boolean
): WireTallyGroup {
  const group = one(origin, "tally_group", "group_id", itemId);
  if (!group)
    throw new VaultShareError(
      `tally.group ${itemId} is not in the origin vault`
    );
  const circleId = String(group.circle_id);
  const circle = one(origin, "social_circle", "circle_id", circleId);
  if (!circle)
    throw new VaultShareError(`Tally group ${itemId} has no audience circle`);
  const members = rows(origin, "social_circle_member", "circle_id", circleId);
  const expenses = rows(origin, "tally_expense", "group_id", itemId);
  const splits = expenses.flatMap((expense) =>
    rows(
      origin,
      "tally_expense_split",
      "expense_id",
      String(expense.expense_id)
    )
  );
  const settlements = rows(origin, "tally_settlement", "group_id", itemId);
  const recurring = rows(origin, "tally_recurring_expense", "group_id", itemId);
  const exceptions = recurring.flatMap(
    (template) =>
      origin
        .prepare(
          `SELECT * FROM schedule_recurrence_exception
            WHERE target_type = 'tally.recurring_expense' AND target_id = ?`
        )
        .all(String(template.template_id)) as WireRow[]
  );
  const receipts = expenses.flatMap((expense) =>
    rows(
      origin,
      "tally_expense_receipt",
      "expense_id",
      String(expense.expense_id)
    )
  );
  const lineItems = receipts.flatMap((receipt) =>
    rows(
      origin,
      "tally_expense_line_item",
      "receipt_id",
      String(receipt.receipt_id)
    )
  );
  const lineAllocations = lineItems.flatMap((line) =>
    rows(
      origin,
      "tally_expense_line_allocation",
      "line_item_id",
      String(line.line_item_id)
    )
  );
  for (const receipt of receipts) poolContent(String(receipt.content_id));
  return {
    group,
    circle,
    members,
    parties: readParties(origin, [
      ...members.map((row) => String(row.party_id)),
      ...expenses.map((row) => String(row.paid_by)),
      ...splits.map((row) => String(row.party_id)),
      ...settlements.flatMap((row) => [
        String(row.from_party),
        String(row.to_party),
      ]),
      ...recurring.map((row) => String(row.paid_by)),
      ...lineAllocations.map((row) => String(row.party_id)),
    ]),
    expenses,
    splits,
    settlements,
    recurring,
    exceptions,
    receipts,
    lineItems,
    lineAllocations,
  };
}

/** Every party the ledger names, once, skipping ids with no row behind them. */
function readParties(origin: DatabaseSync, partyIds: string[]): WireRow[] {
  return [...new Set(partyIds)].flatMap((partyId) => {
    const party = one(origin, "core_party", "party_id", partyId);
    return party ? [party] : [];
  });
}
