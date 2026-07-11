/**
 * Ingest one file into the library through media.add_asset. Bytes arrive
 * either STAGED (issue #296: the app streamed them to /_vault/blobs and
 * claims the sha here — large files, EXIF read server-side) or as a small
 * inline data: URI. Identical bytes collapse onto one asset, and
 * re-uploading a deleted photo restores it. Risk low.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'media.add_asset',
      input: {
        ...(input.staged_sha != null
          ? { staged_sha: String(input.staged_sha) }
          : { data_uri: String(input.data_uri ?? '') }),
        ...(input.kind != null ? { kind: String(input.kind) } : {}),
        ...(input.captured_at != null ? { captured_at: String(input.captured_at) } : {}),
        ...(input.title != null ? { title: String(input.title) } : {}),
        ...(input.width != null ? { width: Number(input.width) } : {}),
        ...(input.height != null ? { height: Number(input.height) } : {}),
        ...(input.duration_s != null ? { duration_s: Number(input.duration_s) } : {}),
        // Perceptual hash (issue #299 Tier 0) — computed client-side from
        // the same canvas that grew the thumb; near-dups become plain SQL.
        ...(input.phash != null ? { phash: String(input.phash) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
