/**
 * Pin a file to a note through core.attach. Bytes arrive either STAGED
 * (issue #296: the app streamed them to /_vault/blobs and claims the sha
 * here — big files) or as a small inline data: URI; the vault dedupes the
 * bytes into a canonical content item and links it. The same handler shape is
 * copied across every app — only the subject_type differs.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.attach',
      input: {
        subject_type: 'knowledge.note',
        subject_id: String(input.subject_id ?? ''),
        ...(input.staged_sha != null
          ? { staged_sha: String(input.staged_sha) }
          : { data_uri: String(input.data_uri ?? '') }),
        ...(input.title != null ? { title: String(input.title) } : {}),
        ...(input.role != null ? { role: String(input.role) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
