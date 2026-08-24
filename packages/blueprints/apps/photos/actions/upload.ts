/**
 * Ingest one file into the library through media.add_asset. Bytes arrive
 * either STAGED (#296: the app streamed them to /_vault/blobs and
 * claims the sha here — large files, EXIF read server-side) or as a small
 * inline data: URI. Identical bytes collapse onto one asset, and
 * re-uploading a deleted photo restores it. Risk low.
 *
 * @type {import('@centraid/server/engine').ActionHandler}
 */
export default async function upload({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "media.add_asset",
      input: {
        ...(input.staged_sha == null
          ? { data_uri: String(input.data_uri ?? "") }
          : { staged_sha: String(input.staged_sha) }),
        ...(input.kind == null ? {} : { kind: String(input.kind) }),
        ...(input.captured_at == null
          ? {}
          : { captured_at: String(input.captured_at) }),
        // Capture-local UTC offset (#419) and Live Photo pairing
        // (#721/#724 A2) both ride the same schema field this action
        // already declares — they were validated here and then silently
        // dropped before reaching media.add_asset (#724 audit). Forwarded now
        // like every other optional field on this action.
        ...(input.tz_offset_min == null
          ? {}
          : { tz_offset_min: Number(input.tz_offset_min) }),
        ...(input.capture_group_id == null
          ? {}
          : { capture_group_id: String(input.capture_group_id) }),
        // Edit lineage (#711): the editor saves a crop as a new asset
        // and names the one it came from. Only forwarded when the caller
        // actually knows a source — an ordinary upload has none, and an empty
        // string is not a lineage.
        ...(input.source_asset_id == null
          ? {}
          : { source_asset_id: String(input.source_asset_id) }),
        ...(input.title == null ? {} : { title: String(input.title) }),
        ...(input.width == null ? {} : { width: Number(input.width) }),
        ...(input.height == null ? {} : { height: Number(input.height) }),
        ...(input.duration_s == null
          ? {}
          : { duration_s: Number(input.duration_s) }),
        // Perceptual hash (#299 Tier 0) — computed client-side from
        // the same canvas that grew the thumb; near-dups become plain SQL.
        ...(input.phash == null ? {} : { phash: String(input.phash) }),
        ...(input.thumbhash == null
          ? {}
          : { thumbhash: String(input.thumbhash) }),
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
