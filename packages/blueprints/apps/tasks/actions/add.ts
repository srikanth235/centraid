import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Optional fields are forwarded only when present, so the command contract
 *  (additionalProperties: false) sees exactly what the user set. */
export default async function add({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const raw = actionInput(body);
  const input: Record<string, unknown> = { title: String(raw.title ?? "") };
  // The seat mints the row's id and the origin honours it (#922 G2), so a
  // child write filed offline against it lands pointing at the same row.
  if (raw.task_id) input.task_id = String(raw.task_id);
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
