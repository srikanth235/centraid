import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function deleteContactChannel({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  return runVaultAction(ctx, {
    command: "people.delete_contact_channel",
    input: actionInput(body),
  });
}
