/**
 * Move a document to the trash through core.trash_document: sets deleted_at
 * and a purge date about 30 days out, keeping the folder tag so a restore
 * lands it back where it was. The vault refuses ('not_rented_elsewhere')
 * while the bytes are still referenced elsewhere in the vault. Risk low.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.trash_document',
      input: {
        content_id: String(input.content_id ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
