import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** tally.reallocate_receipt — contract in app.json. */
const KEYS = ["expense_id", "line_items", "splits"];
export default async function reallocateReceipt({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {};
  for (const k of KEYS)
    if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  return runVaultAction(ctx, {
    command: "tally.reallocate_receipt",
    input: cmdInput,
  });
}
