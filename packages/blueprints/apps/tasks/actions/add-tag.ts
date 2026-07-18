/**
 * Tag a task through core.tag_item — a free-form label shared with every
 * other app that tags through the same command (same Tags concept scheme).
 * Idempotent: tagging with a label already on the task just returns the
 * existing edge.
 */
export default async ({ body, ctx }: HandlerArgs): Promise<ActionResult> => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.tag_item',
      input: {
        subject_type: 'schedule.task',
        subject_id: String(input.task_id ?? ''),
        label: String(input.label ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
