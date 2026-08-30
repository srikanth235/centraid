import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function saveRecurringExpense({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  return runVaultAction(ctx, {
    command: "tally.save_recurring_expense",
    input: actionInput(body),
  });
}
