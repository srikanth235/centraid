import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

const KEYS = ["group_id"];
export default async function deleteGroup({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {};
  for (const k of KEYS)
    if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  return runVaultAction(ctx, {
    command: "tally.delete_group",
    input: cmdInput,
  });
}
