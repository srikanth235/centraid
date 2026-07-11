/**
 * Remove one free-form label from a photo through core.untag_entity (issue
 * #352 phase 3/4) — the other half of tag-asset.js's additive gesture.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.untag_entity',
      input: {
        target_type: 'media.media_asset',
        target_id: String(input.asset_id ?? ''),
        label: String(input.label ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
