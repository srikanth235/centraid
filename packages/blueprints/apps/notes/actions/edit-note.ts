/**
 * Edit a note through the vault's typed command — partial update: only the
 * fields sent change, and a body edit re-points the note at a new (or
 * deduped) content item rather than mutating canonical bytes. Pinning is a
 * field here, not a separate command: it's a flag with no lifecycle.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'knowledge.edit_note',
      input: {
        note_id: String(input.note_id ?? ''),
        ...(input.title != null ? { title: String(input.title) } : {}),
        ...(input.body_text != null ? { body_text: String(input.body_text) } : {}),
        ...(input.format != null ? { format: String(input.format) } : {}),
        ...(input.pinned != null ? { pinned: Number(input.pinned) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
