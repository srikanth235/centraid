import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function setStatus({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "schedule.set_task_status",
    input: {
      task_id: String(input.task_id ?? ""),
      status: String(input.status ?? ""),
    },
  });
}
