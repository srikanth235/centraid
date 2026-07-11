/**
 * Recaption a photo, fix its capture time, or toggle its favorite heart
 * through media.update_asset. The title is the caption, stored on the
 * content item; captured_at and favorite live on the asset. Risk low.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'media.update_asset',
      input: {
        asset_id: String(input.asset_id ?? ''),
        ...(input.captured_at != null ? { captured_at: String(input.captured_at) } : {}),
        ...(input.title != null ? { title: String(input.title) } : {}),
        ...(input.favorite != null ? { favorite: Number(input.favorite) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
