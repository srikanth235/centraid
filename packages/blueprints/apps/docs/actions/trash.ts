/**
 * Move a document to the trash through core.trash_document: sets deleted_at
 * and a purge date about 30 days out, keeping the folder tag so a restore
 * lands it back where it was. The vault refuses ('not_rented_elsewhere')
 * while the bytes are still referenced elsewhere in the vault. Risk low.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.trash_document',
      input: {
        document_id: String(input.document_id ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
