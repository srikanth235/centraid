import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * tally.archive_group — contract in app.json.
 * Archiving is not deleting, and it does not need a settled balance.
 */
const KEYS = ["group_id", "archived"];
export default async function archiveGroup({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {};
  for (const k of KEYS)
    if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  return runVaultAction(ctx, {
    command: "tally.archive_group",
    input: cmdInput,
  });
}
