/**
 * Remove a document's star through core.unstar_document — deletes the
 * flags-scheme tag on the canonical content item (issue #274). Idempotent;
 * refuses trashed documents (a trashed document keeps its star through
 * restore). Risk low.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.unstar_document',
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
