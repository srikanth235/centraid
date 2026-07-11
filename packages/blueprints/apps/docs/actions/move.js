/**
 * Refile a document into a folder through core.move_document — omitting
 * folder_id moves it to the drive's top level. Filing is one folders-scheme
 * tag per document, so a move swaps the tag. Risk low.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
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
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
