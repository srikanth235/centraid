/**
 * Add a free-form label to a document through core.tag_item (issue #352
 * phase 4) — additive and idempotent over the shared "Tags" concept scheme
 * (packages/vault/src/commands/tags.ts, the same scheme notes/tasks tag
 * through); tagging the same label twice just dedupes onto the one tag row.
 * Mirrors the photos app's tag-asset.js verbatim, save for the subject type
 * (a document wrapper, not an asset).
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.tag_item',
      input: {
        subject_type: 'core.document',
        subject_id: String(input.document_id ?? ''),
        label: String(input.label ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
