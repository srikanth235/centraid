/**
 * Delete a note through the vault's typed command. The note goes away with
 * its placements, annotations and attachment edges; the body is a deduped
 * canonical content item, so its bytes are only released when nothing else
 * shares them — the outcome reports body_released either way.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'knowledge.delete_note',
      input: {
        note_id: String(input.note_id ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
