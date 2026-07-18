/**
 * Refile a document into a folder through core.move_document — omitting
 * folder_id moves it to the drive's top level. Filing is one folders-scheme
 * tag per document, so a move swaps the tag. Risk low.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.move_document',
      input: {
        document_id: String(input.document_id ?? ''),
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
