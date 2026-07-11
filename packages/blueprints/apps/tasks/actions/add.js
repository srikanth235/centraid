/**
 * Add a task through the vault's typed command. The row lands in
 * schedule.task with provenance naming this invocation — this app stores
 * nothing. Optional fields are forwarded only when present, so the
 * command contract (additionalProperties: false) sees exactly what the
 * user set. Outcome passed through for the UI to narrate.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const raw = body ?? {};
  const input = { title: String(raw.title ?? '') };
  if (raw.description) input.description = String(raw.description);
  if (raw.due_at) input.due_at = String(raw.due_at);
  if (raw.priority) input.priority = Number(raw.priority);
  if (raw.effort_min) input.effort_min = Number(raw.effort_min);
  if (raw.parent_task_id) input.parent_task_id = String(raw.parent_task_id);
  try {
    const outcome = await ctx.vault.invoke({
      command: 'schedule.add_task',
      input,
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
