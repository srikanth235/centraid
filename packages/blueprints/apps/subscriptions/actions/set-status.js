/**
 * Pause or cancel a subscription through finance.set_subscription_status
 * (active | paused | ended). Risk low — a state change, no ledger effect.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'finance.set_subscription_status',
      input: {
        series_id: String(input.series_id ?? ''),
        status: String(input.status ?? ''),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
