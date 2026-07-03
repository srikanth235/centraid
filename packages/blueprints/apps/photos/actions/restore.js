/**
 * Bring a trashed photo back through media.restore_asset. The asset row
 * and its bytes un-soft-delete with metadata intact; album membership is
 * not restored, matching the benchmark's trash model. Restoring a live
 * photo fails as a precondition, not an error. Risk low.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'media.restore_asset',
      input: { asset_id: String(input.asset_id ?? '') },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
