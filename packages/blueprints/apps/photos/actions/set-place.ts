/**
 * Correct or clear a photo's place through media.set_asset_place (issue
 * #352 phase 3/4). The vault links a place automatically from EXIF GPS at
 * upload; this is the owner's override. There is no app-plane command to
 * MINT a brand-new named place — only to point the asset at an existing
 * core.place row (`place_id` given) or clear it back to unknown
 * (`place_id` omitted).
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'media.set_asset_place',
      input: {
        asset_id: String(input.asset_id ?? ''),
        ...(input.place_id != null && input.place_id !== ''
          ? { place_id: String(input.place_id) }
          : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
