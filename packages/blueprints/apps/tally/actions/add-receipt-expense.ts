import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function addReceiptExpense({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "tally.add_receipt_expense",
    input: actionInput(body),
  });
}
