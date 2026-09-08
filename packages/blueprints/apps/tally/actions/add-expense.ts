import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** tally.add_expense — contract in app.json. */
const KEYS = [
  // The seat mints the row's id and the origin honours it (#922 G2).
  "expense_id",
  "group_id",
  "description",
  "amount_minor",
  "paid_by",
  "spent_on",
  "category",
  "splits",
  "payers",
  "split_method",
  "split_params",
  "line_items",
  "original_amount_minor",
  "original_currency",
  "settlement_currency",
  "rate_scaled",
  "rate_scale",
  "rate_source",
  "rate_date",
];
export default async function addExpense({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {};
  for (const k of KEYS)
    if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  return runVaultAction(ctx, {
    command: "tally.add_expense",
    input: cmdInput,
  });
}
