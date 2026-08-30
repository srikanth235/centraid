import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function undoExpense({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "tally.undo_expense",
    input: actionInput(body),
  });
}
