import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

const KEYS = ["party_id", "group_id", "as_of_minor", "note"];
export default async function nudge({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {};
  for (const k of KEYS)
    if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  return runVaultAction(ctx, {
    command: "tally.nudge",
    input: cmdInput,
  });
}
