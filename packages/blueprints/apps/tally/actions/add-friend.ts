import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** `party_id`/`email`/`phone` enroll a known party, never a second
 *  `core_party` for one human (#883). */
const KEYS = ["name", "party_id", "email", "phone"];
export default async function addFriend({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {};
  for (const k of KEYS)
    if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  return runVaultAction(ctx, {
    command: "tally.add_friend",
    input: cmdInput,
  });
}
