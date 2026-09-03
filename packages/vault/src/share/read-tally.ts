import type { DatabaseSync } from "node:sqlite";

import { VaultShareError } from "../errors.js";
import type { WireRow, WireTallyGroup } from "./closure.js";
import { one, rows } from "./sql.js";

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
  const payers = expenses.flatMap((expense) =>
    rows(
      origin,
      "tally_expense_payer",
      "expense_id",
      String(expense.expense_id)
    )
  );
  const settlements = rows(origin, "tally_settlement", "group_id", itemId);
  const recurring = rows(origin, "tally_recurring_expense", "group_id", itemId);
  const recurringSplits = recurring.flatMap(
    (template) =>
      origin
        .prepare(
          `SELECT * FROM tally_recurring_expense_split WHERE template_id = ?`
        )
        .all(String(template.template_id)) as WireRow[]
  );
  const exceptions = recurring.flatMap(
    (template) =>
      origin
        .prepare(
          `SELECT * FROM schedule_recurrence_exception
            WHERE target_type = 'tally.recurring_expense' AND target_id = ?`
        )
        .all(String(template.template_id)) as WireRow[]
  );
  const receipts = expenses.flatMap(
    (expense) =>
      origin
        .prepare(
          `SELECT * FROM core_attachment
            WHERE target_type = 'tally.expense' AND target_id = ?
              AND role = 'receipt'
            ORDER BY attachment_id`
        )
        .all(String(expense.expense_id)) as WireRow[]
  );
  const lineItems = expenses.flatMap((expense) =>
    rows(
      origin,
      "tally_expense_line_item",
      "expense_id",
      String(expense.expense_id)
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
      ...payers.map((row) => String(row.party_id)),
      ...settlements.flatMap((row) => [
        String(row.from_party),
        String(row.to_party),
      ]),
      ...recurring.map((row) => String(row.paid_by)),
      ...recurringSplits.map((row) => String(row.party_id)),
      ...lineAllocations.map((row) => String(row.party_id)),
    ]),
    expenses,
    splits,
    payers,
    settlements,
    recurring,
    recurringSplits,
    exceptions,
    receipts,
    lineItems,
    lineAllocations,
  };
}

function readParties(origin: DatabaseSync, partyIds: string[]): WireRow[] {
  return [...new Set(partyIds)].flatMap((partyId) => {
    const party = one(origin, "core_party", "party_id", partyId);
    return party ? [party] : [];
  });
}
