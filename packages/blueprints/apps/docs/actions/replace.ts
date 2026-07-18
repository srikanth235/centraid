/**
 * Replace a document's bytes (any media type) through
 * core.replace_document_content — the "Replace file…" door for scanned
 * PDFs, images and anything edit.js can't touch structurally. Bytes arrive
 * staged (issue #296) or as a small inline data: URI, same door upload.js
 * uses. Mints a new content item, records the `revises` link, and repoints
 * the wrapper's current version; title is an optional partial update.
 * Refuses trashed documents. Risk low.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.replace_document_content',
      input: {
        document_id: String(input.document_id ?? ''),
        ...(input.staged_sha != null
          ? { staged_sha: String(input.staged_sha) }
          : { data_uri: String(input.data_uri ?? '') }),
        ...(input.title != null ? { title: String(input.title) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
