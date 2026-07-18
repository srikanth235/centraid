/**
 * Create a note through the vault's typed command. The body is stored as a
 * canonical core.content_item (sha256-deduped data: URI) — the note row only
 * references it. Filing is optional: pass notebook_id to place the note at
 * the end of that notebook. The outcome passes through verbatim so the UI
 * can narrate what the consent plane decided.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'knowledge.create_note',
      input: {
        title: String(input.title ?? ''),
        body_text: String(input.body_text ?? ''),
        ...(input.format != null ? { format: String(input.format) } : {}),
        ...(input.notebook_id != null ? { notebook_id: String(input.notebook_id) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
