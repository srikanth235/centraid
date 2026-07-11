/**
 * Add a free-form label to a photo through core.tag_entity (issue #352
 * phase 3/4) — additive and idempotent over the owner "Labels" concept
 * scheme (packages/vault/src/commands/tags.ts); tagging the same label
 * twice just dedupes onto the one tag row.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.tag_entity',
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
