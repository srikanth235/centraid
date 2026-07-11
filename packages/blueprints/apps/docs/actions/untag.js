/**
 * Remove one free-form label from a document through core.untag_entity — the
 * other half of tag.js's additive gesture.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.untag_entity',
      input: {
        target_type: 'core.document',
        target_id: String(input.document_id ?? ''),
        label: String(input.label ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
