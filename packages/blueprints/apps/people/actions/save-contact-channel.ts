import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function saveContactChannel({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  return runVaultAction(ctx, {
    command: "people.save_contact_channel",
    input: actionInput(body),
  });
}
