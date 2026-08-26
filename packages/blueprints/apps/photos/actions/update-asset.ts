/**
 * Recaption a photo, fix its capture time, or toggle its favorite heart or
 * its archived flag through media.update_asset. The title is the caption,
 * stored on the content item; captured_at, favorite and archived live on the
 * asset. Risk low.
 *
 * Every optional field app.json's schema declares is forwarded — `archived`
 * included, which the vault command writes as `media_asset.archived_at`. A
 * field dropped here returns 200 and changes nothing, which is the Archived
 * shelf with no door that works.
 *
 * @type {import('@centraid/server/engine').ActionHandler}
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
