/**
 * Tag a note through core.tag_item — a free-form label shared with every
 * other app that tags through the same command (same Tags concept scheme).
 * Idempotent: tagging with a label already on the note just returns the
 * existing edge.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.tag_item',
      input: {
        subject_type: 'knowledge.note',
        subject_id: String(input.note_id ?? ''),
        label: String(input.label ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
