import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function materializeRecurringExpense({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  return runVaultAction(ctx, {
    command: "tally.materialize_recurring_expense",
    input: actionInput(body),
  });
}
