/**
 * Remove a file from a note through core.detach. The edge goes; the canonical
 * content item stays (it is deduped and may back other attachments). Same
 * handler shape across every app.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.detach',
      input: { attachment_id: String(input.attachment_id ?? '') },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
