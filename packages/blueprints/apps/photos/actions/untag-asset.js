/**
 * Remove one free-form label from a photo through core.untag_item (issue
 * #352 phase 3/4) — the other half of tag-asset.js's additive gesture.
 * Removes by tag_id (the specific edge), not by label — the caller (the
 * lightbox's tag chip) already has it from the asset's own `tags` join.
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
