import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** tally.create_group — contract in app.json. */
const KEYS = [
  // The seat mints the row's id and the origin honours it (#922 G2).
  "group_id",
  "name",
  "icon",
  "color",
  "member_ids",
];
export default async function createGroup({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {};
  for (const k of KEYS)
    if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  return runVaultAction(ctx, {
    command: "tally.create_group",
    input: cmdInput,
  });
}
