import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function editRecurringExpenseOccurrence({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  return runVaultAction(ctx, {
    command: "tally.edit_recurring_expense_occurrence",
    input: actionInput(body),
  });
}
