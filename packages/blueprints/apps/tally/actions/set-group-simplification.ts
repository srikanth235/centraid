import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * tally.set_group_simplification — contract in app.json.
 * Writes the OPT-IN FLAG only; the proposal itself is derived at read time.
 */
const KEYS = ["group_id", "simplify"];
export default async function setGroupSimplification({
  body,
  ctx,
}: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {};
  for (const k of KEYS)
    if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  return runVaultAction(ctx, {
    command: "tally.set_group_simplification",
    input: cmdInput,
  });
}
