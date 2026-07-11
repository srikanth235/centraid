/**
 * Rename a document through core.rename_document. The vault refuses trashed
 * documents — restore first, then rename. Risk low.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.rename_document',
      input: {
        document_id: String(input.document_id ?? ''),
        title: String(input.title ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
