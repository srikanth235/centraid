/**
 * Remove one free-form label from a document through core.untag_item — the
 * other half of tag.js's additive gesture. Removes by tag_id (the specific
 * edge), not by label — the caller already has it from the document's own
 * `tags` join.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.untag_item',
      input: { tag_id: String(input.tag_id ?? '') },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
