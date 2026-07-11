/**
 * Take a photo out of an album through media.remove_from_album; the photo
 * itself stays in the library. Risk low.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'media.remove_from_album',
      input: {
        album_id: String(input.album_id ?? ''),
        asset_id: String(input.asset_id ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
