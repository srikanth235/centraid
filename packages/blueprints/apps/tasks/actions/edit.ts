import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function edit({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const raw = actionInput(body);
  const input: Record<string, unknown> = { task_id: String(raw.task_id ?? "") };
  if (raw.title) input.title = String(raw.title);
  if (raw.description) input.description = String(raw.description);
  if (raw.clear_description === true) input.clear_description = true;
  if (raw.due_at) input.due_at = String(raw.due_at);
  if (raw.clear_due === true) input.clear_due = true;
  if (raw.priority !== undefined) input.priority = Number(raw.priority);
  if (raw.effort_min) input.effort_min = Number(raw.effort_min);
  if (raw.remind_before_min !== undefined)
    input.remind_before_min = Number(raw.remind_before_min);
  if (raw.clear_remind === true) input.clear_remind = true;
  if (raw.rrule) input.rrule = String(raw.rrule);
  if (raw.clear_rrule === true) input.clear_rrule = true;
  return runVaultAction(ctx, { command: "schedule.edit_task", input });
}
