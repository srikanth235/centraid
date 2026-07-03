/**
 * Ingest one file into the library through media.add_asset. The bytes ride
 * in as a data: URI and land as a deduped canonical content item: identical
 * bytes collapse onto one asset, and re-uploading a deleted photo restores
 * it. Kind is inferred from the media type when not given. Risk low.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'media.add_asset',
      input: {
        data_uri: String(input.data_uri ?? ''),
        ...(input.kind != null ? { kind: String(input.kind) } : {}),
        ...(input.captured_at != null ? { captured_at: String(input.captured_at) } : {}),
        ...(input.title != null ? { title: String(input.title) } : {}),
        ...(input.width != null ? { width: Number(input.width) } : {}),
        ...(input.height != null ? { height: Number(input.height) } : {}),
        ...(input.duration_s != null ? { duration_s: Number(input.duration_s) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
