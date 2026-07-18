/**
 * Restore an older version through core.restore_document_version — history
 * never rewrites (rule R3): this asserts a NEW forward `revises` link and
 * repoints current_content_id at the chosen past content item, so the old
 * chain stays exactly as it was and a restore-of-a-restore never loops.
 * Refuses a content id that is already current, or one outside this
 * document's own chain. Risk low.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.restore_document_version',
      input: {
        document_id: String(input.document_id ?? ''),
        content_id: String(input.content_id ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
