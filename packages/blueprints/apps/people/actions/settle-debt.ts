import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Closed, not deleted: settled debts stay as history. */
export default async function settleDebt({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.settle_debt",
    input: actionInput(body),
  });
}
