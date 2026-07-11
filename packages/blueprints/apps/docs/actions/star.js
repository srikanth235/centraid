/**
 * Star a document through core.star_document: one flags-scheme tag on the
 * canonical content item (issue #274) — the same star Photos' favorite
 * writes, so "Starred" means one thing across every surface. Idempotent;
 * refuses trashed documents (restore first). Risk low.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.star_document',
      input: {
        document_id: String(input.document_id ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
