/**
 * Move a task through the VTODO lifecycle via the vault's typed command.
 * The command's postcondition owns the completed_at invariant (stamped
 * iff completed), so this handler is a pure pass-through. Outcome passed
 * through for the UI to narrate.
 */
export default async ({ body, ctx }: HandlerArgs): Promise<ActionResult> => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'schedule.set_task_status',
      input: { task_id: String(input.task_id ?? ''), status: String(input.status ?? '') },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
