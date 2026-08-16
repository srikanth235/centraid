/**
 * Put a photo in an album through media.add_to_album; the entry lands at
 * the end of the album's running order. Already a member is a 'failed'
 * outcome (a precondition, not an error), which the UI narrates. Risk low.
 *
 * @type {import('@centraid/server/engine').ActionHandler}
 */
export default async function addToAlbum({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "media.add_to_album",
      input: {
        album_id: String(input.album_id ?? ""),
        asset_id: String(input.asset_id ?? ""),
      },
      purpose: "dpv:ServiceProvision",
    });
    return { status: 200, body: outcome };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      status: 200,
      body: { status: "denied", reason: e.message, code: e.code },
    };
  }
}
