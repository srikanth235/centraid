/**
 * Start a new album through media.create_album. Risk low.
 *
 * @type {import('@centraid/server/engine').ActionHandler}
 */
export default async function createAlbum({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "media.create_album",
      input: { title: String(input.title ?? "") },
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
