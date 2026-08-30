import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function editOccurrence({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  return runVaultAction(ctx, {
    command: "schedule.edit_event_occurrence",
    input: actionInput(body),
  });
}
