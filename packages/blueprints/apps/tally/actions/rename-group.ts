import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** tally.rename_group — contract in app.json. */
const KEYS = ["group_id", "name"];
export default async function renameGroup({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {};
  for (const k of KEYS)
    if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  return runVaultAction(ctx, {
    command: "tally.rename_group",
    input: cmdInput,
  });
}
