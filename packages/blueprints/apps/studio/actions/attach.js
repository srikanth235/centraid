/**
 * Pin a file to an invoice through core.attach. The blueprint reads the File as
 * a base64 data: URI client-side and passes it here; the vault dedupes the
 * bytes into a canonical content item and links it. The same handler shape is
 * copied across every app — only the subject_type differs.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.attach',
      input: {
        subject_type: 'business.invoice',
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
