/**
 * Enroll a party as a new lead through business.add_client (status 'lead').
 * A lead is just a client at the top of the pipeline. Risk low.
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
        status: 'lead',
        ...(input.default_rate_minor != null
          ? { default_rate_minor: Number(input.default_rate_minor) }
          : {}),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
