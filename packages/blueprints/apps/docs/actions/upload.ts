/**
 * Add a document through core.add_document. Bytes arrive either STAGED
 * (issue #296: the app streamed them to /_vault/blobs and claims the sha
 * here — big files, text extracted server-side for search) or as a small
 * inline data: URI. Omit folder_id for the drive's top level; re-uploading
 * identical bytes restores them from trash and renames them. Risk low.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.add_document',
      input: {
        ...(input.staged_sha != null
          ? { staged_sha: String(input.staged_sha) }
          : { data_uri: String(input.data_uri ?? '') }),
        title: String(input.title ?? ''),
        ...(input.folder_id != null ? { folder_id: String(input.folder_id) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
