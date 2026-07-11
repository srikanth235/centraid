/**
 * Put a photo in an album through media.add_to_album; the entry lands at
 * the end of the album's running order. Already a member is a 'failed'
 * outcome (a precondition, not an error), which the UI narrates. Risk low.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'media.add_to_album',
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
