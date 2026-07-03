/**
 * Pin a file (a proposal, a brief) to a lead through core.attach. Same
 * handler shape across every app — only the subject_type differs.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.attach',
      input: {
        subject_type: 'business.client',
        subject_id: String(input.subject_id ?? ''),
        data_uri: String(input.data_uri ?? ''),
        ...(input.title != null ? { title: String(input.title) } : {}),
        ...(input.role != null ? { role: String(input.role) } : {}),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
