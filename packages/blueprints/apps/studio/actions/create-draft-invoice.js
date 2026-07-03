/**
 * Bill unbilled hours through the vault's typed command: one call creates
 * the draft and its lines from the selected time entries, marking each as
 * billed (double-billing is refused vault-side). Risk medium — under the
 * app's default low risk ceiling this parks for owner confirmation; the
 * outcome passes through verbatim so the UI narrates the wait instead of
 * treating it as failure.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'business.create_draft_invoice',
      input: {
        client_id: String(input.client_id ?? ''),
        entry_ids: Array.isArray(input.entry_ids) ? input.entry_ids.map(String) : [],
        due_on: String(input.due_on ?? ''),
        ...(input.number != null ? { number: String(input.number) } : {}),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
