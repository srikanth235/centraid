import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** tally.settle_up — contract in app.json. */
const KEYS = [
  // The seat mints the row's id and the origin honours it (#922 G2).
  "settlement_id",
  "from_party",
  "to_party",
  "amount_minor",
  "group_id",
  "paid_on",
];
export default async function settleUp({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {};
  for (const k of KEYS)
    if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  return runVaultAction(ctx, {
    command: "tally.settle_up",
    input: cmdInput,
  });
}
