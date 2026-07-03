/**
 * Record a recurring charge through finance.add_subscription. The account and
 * cadence (rrule) come from the form; the vault stores the series active with
 * a tolerance band the reconciler later matches transactions against. Risk
 * low — declaring a subscription touches no outward party and no ledger row.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'finance.add_subscription',
      input: {
        account_id: String(input.account_id ?? ''),
        expected_minor: Number(input.expected_minor ?? 0),
        rrule: String(input.rrule ?? ''),
        ...(input.counterparty_party_id != null
          ? { counterparty_party_id: String(input.counterparty_party_id) }
          : {}),
        ...(input.tolerance_pct != null ? { tolerance_pct: Number(input.tolerance_pct) } : {}),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
