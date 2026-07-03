/**
 * Remove a photo from the library through media.delete_asset. Album
 * entries and face regions go with it, covers hand off automatically,
 * and the bytes soft-delete only when nothing else references them —
 * re-uploading the same file restores the photo. Risk low.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'media.delete_asset',
      input: { asset_id: String(input.asset_id ?? '') },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
