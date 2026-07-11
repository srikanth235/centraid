/**
 * Remove one free-form label from a document through core.untag_item — the
 * other half of tag.js's additive gesture. Removes by tag_id (the specific
 * edge), not by label — the caller already has it from the document's own
 * `tags` join.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.untag_item',
      input: { tag_id: String(input.tag_id ?? '') },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
