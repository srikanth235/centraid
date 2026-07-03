/**
 * Enroll a party as a client through the vault's typed command — one client
 * per party, the identity anchor stays singular. The outcome passes through
 * verbatim so the UI can narrate what the consent plane decided.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'business.add_client',
      input: {
        party_id: String(input.party_id ?? ''),
        currency: String(input.currency ?? ''),
        ...(input.status != null ? { status: String(input.status) } : {}),
        ...(input.default_rate_minor != null
          ? { default_rate_minor: Number(input.default_rate_minor) }
          : {}),
        ...(input.payment_terms_days != null
          ? { payment_terms_days: Number(input.payment_terms_days) }
          : {}),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
