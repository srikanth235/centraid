import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

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
