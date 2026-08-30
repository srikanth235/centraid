import { runVaultAction } from "../../_shared/action-kit.ts";

export default async function restoreExpense({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as { expense_id?: unknown };
  return runVaultAction(ctx, {
    command: "tally.restore_expense",
    input: { expense_id: input.expense_id },
  });
}
