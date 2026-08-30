import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** tally.delete_expense — contract in app.json. */
const KEYS = ["expense_id"];
export default async function deleteExpense({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {};
  for (const k of KEYS)
    if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  return runVaultAction(ctx, {
    command: "tally.delete_expense",
    input: cmdInput,
  });
}
