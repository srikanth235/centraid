/**
 * Edit a subscription in place through finance.update_subscription — a
 * partial update: only the fields sent change. Price, cadence (rrule), the
 * anchor date the cadence counts from, payee and tolerance all travel the
 * same typed command. Risk low — reshapes the series, no ledger effect.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'finance.update_subscription',
      input: {
        series_id: String(input.series_id ?? ''),
        ...(input.expected_minor != null ? { expected_minor: Number(input.expected_minor) } : {}),
        ...(input.rrule != null ? { rrule: String(input.rrule) } : {}),
        ...(input.anchor_on != null ? { anchor_on: String(input.anchor_on) } : {}),
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
