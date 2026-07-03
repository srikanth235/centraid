/**
 * Release a draft invoice through business.send_invoice — the moment an
 * internal draft becomes an outward commitment to a client for a specific
 * amount. Risk high: invoked by an app it always parks for the owner's
 * confirmation, so the returned status is 'parked', not 'executed'.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'business.send_invoice',
      input: { invoice_id: String(input.invoice_id ?? '') },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
