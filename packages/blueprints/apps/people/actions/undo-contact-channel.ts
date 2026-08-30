import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function undoContactChannel({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  return runVaultAction(ctx, {
    command: "people.undo_contact_channel",
    input: actionInput(body),
  });
}
