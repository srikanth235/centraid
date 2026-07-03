/**
 * Edit a task's fields through the vault's typed command. Only the fields
 * the user actually changed are forwarded; clearing a due date or a note
 * is the explicit clear_due / clear_description intent, never an empty
 * string. Outcome passed through for the UI to narrate.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const raw = body ?? {};
  const input = { task_id: String(raw.task_id ?? '') };
  if (raw.title) input.title = String(raw.title);
  if (raw.description) input.description = String(raw.description);
  if (raw.clear_description === true) input.clear_description = true;
  if (raw.due_at) input.due_at = String(raw.due_at);
  if (raw.clear_due === true) input.clear_due = true;
  if (raw.priority !== undefined) input.priority = Number(raw.priority);
  if (raw.effort_min) input.effort_min = Number(raw.effort_min);
  try {
    const outcome = await ctx.vault.invoke({
      command: 'schedule.edit_task',
      input,
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
