/**
 * Remove a file from a task through core.detach. The edge goes; the canonical
 * content item stays (it is deduped and may back other attachments). Same
 * handler shape across every app.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.detach',
      input: { attachment_id: String(input.attachment_id ?? '') },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
