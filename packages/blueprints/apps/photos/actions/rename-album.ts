/**
 * Retitle an album through media.rename_album. Risk low.
 *
 * @type {import('@centraid/server/engine').ActionHandler}
 */
export default async function renameAlbum({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "media.rename_album",
      input: {
        album_id: String(input.album_id ?? ""),
        title: String(input.title ?? ""),
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
