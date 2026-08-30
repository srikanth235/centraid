import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function editEvent({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  return runVaultAction(ctx, {
    command: "schedule.edit_event",
    input: actionInput(body),
  });
}
