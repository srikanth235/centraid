/**
 * Move a task through the VTODO lifecycle via the vault's typed command.
 * The command's postcondition owns the completed_at invariant (stamped
 * iff completed), so this handler is a pure pass-through. Outcome passed
 * through for the UI to narrate.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'schedule.set_task_status',
      input: { task_id: String(input.task_id ?? ''), status: String(input.status ?? '') },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
