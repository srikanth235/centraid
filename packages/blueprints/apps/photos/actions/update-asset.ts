/**
 * Recaption a photo, fix its capture time, or toggle its favorite heart or
 * its archived flag through media.update_asset. The title is the caption,
 * stored on the content item; captured_at, favorite and archived live on the
 * asset. Risk low.
 *
 * `archived` was declared in app.json's schema and applied by the vault
 * command (which writes `media_asset.archived_at`) but dropped here, so
 * every hide request returned 200 and changed nothing. The archived shelf and
 * its count have existed on the client the whole time with no door that
 * worked; forwarding the field is that door.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async function updateAsset({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "media.update_asset",
      input: {
        asset_id: String(input.asset_id ?? ""),
        ...(input.captured_at == null
          ? {}
          : { captured_at: String(input.captured_at) }),
        ...(input.title == null ? {} : { title: String(input.title) }),
        ...(input.favorite == null ? {} : { favorite: Number(input.favorite) }),
        ...(input.archived == null ? {} : { archived: Number(input.archived) }),
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
