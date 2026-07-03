/**
 * Pin a file to a booking through core.attach (subject core.event). Bytes are
 * read as a data: URI client-side and deduped into a canonical content item.
 * Same handler shape across every app — only the subject_type differs.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.attach',
      input: {
        subject_type: 'core.event',
        subject_id: String(input.subject_id ?? ''),
        data_uri: String(input.data_uri ?? ''),
        ...(input.title != null ? { title: String(input.title) } : {}),
        ...(input.role != null ? { role: String(input.role) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
