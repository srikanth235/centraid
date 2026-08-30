import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Delete is removal, not a cancelled status — the confirm already promised
 *  the Logbook keeps nothing. */
export default async function deleteTask({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "schedule.delete_task",
    input: { task_id: String(input.task_id ?? "") },
  });
}
