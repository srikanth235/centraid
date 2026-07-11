/**
 * Edit a text-editable document's body in place through core.edit_document —
 * text-editable media types only (media_type LIKE 'text/%'; the vault
 * refuses anything else, replace.js is the door for that). Mints a new (or
 * deduped) content item and records the `revises` link itself; title is an
 * optional partial update, same door rename.js uses. Refuses trashed
 * documents. Risk low.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.edit_document',
      input: {
        document_id: String(input.document_id ?? ''),
        body_text: String(input.body_text ?? ''),
        ...(input.title != null ? { title: String(input.title) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
