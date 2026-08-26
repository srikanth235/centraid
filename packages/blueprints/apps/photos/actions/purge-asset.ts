/**
 * Delete one ALREADY-TRASHED photograph forever, through media.purge_asset
 * (#711). There is no undo: the asset row, its faces, its tags, its
 * album membership and its annotations go now, and the bytes are handed to
 * the gateway's next storage sweep. A photograph that is not in the trash is
 * refused by precondition, as is one an edited copy still points at — the
 * copy must go first, so its record of where it came from never becomes a
 * lie. Risk high; the confirmation is the caller's, before this fires.
 *
 * @type {import('@centraid/server/engine').ActionHandler}
 */
export default async function purgeAsset({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "media.purge_asset",
      input: { asset_id: String(input.asset_id ?? "") },
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
