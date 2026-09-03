import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function add({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const raw = actionInput(body);
  const input: Record<string, unknown> = { title: String(raw.title ?? "") };
  if (raw.description) input.description = String(raw.description);
  if (raw.due_at) input.due_at = String(raw.due_at);
  if (raw.priority) input.priority = Number(raw.priority);
  if (raw.effort_min) input.effort_min = Number(raw.effort_min);
  if (raw.parent_task_id) input.parent_task_id = String(raw.parent_task_id);
  if (raw.rrule) input.rrule = String(raw.rrule);
  if (raw.remind_before_min != null)
    input.remind_before_min = Number(raw.remind_before_min);
  return runVaultAction(ctx, { command: "schedule.add_task", input });
}
