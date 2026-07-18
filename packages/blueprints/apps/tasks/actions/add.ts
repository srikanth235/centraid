/**
 * Add a task through the vault's typed command. The row lands in
 * schedule.task with provenance naming this invocation — this app stores
 * nothing. Optional fields are forwarded only when present, so the
 * command contract (additionalProperties: false) sees exactly what the
 * user set. Outcome passed through for the UI to narrate.
 */
export default async ({ body, ctx }: HandlerArgs): Promise<ActionResult> => {
  const raw = (body ?? {}) as Record<string, unknown>;
  const input: Record<string, unknown> = { title: String(raw.title ?? '') };
  if (raw.description) input.description = String(raw.description);
  if (raw.due_at) input.due_at = String(raw.due_at);
  if (raw.priority) input.priority = Number(raw.priority);
  if (raw.effort_min) input.effort_min = Number(raw.effort_min);
  if (raw.parent_task_id) input.parent_task_id = String(raw.parent_task_id);
  if (raw.rrule) input.rrule = String(raw.rrule);
  if (raw.remind_before_min != null) input.remind_before_min = Number(raw.remind_before_min);
  try {
    const outcome = await ctx.vault.invoke({
      command: 'schedule.add_task',
      input,
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
