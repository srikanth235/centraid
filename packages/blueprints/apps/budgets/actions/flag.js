/**
 * Flag a transaction as anomalous — a tag with a cited reason, never an
 * edit. The vault refuses double-flags via the `not_already_flagged`
 * precondition; those arrive here as `failed` outcomes.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'finance.flag_anomaly',
      input: {
        txn_id: String(input.txn_id ?? ''),
        reason: String(input.reason ?? ''),
        ...(input.confidence != null ? { confidence: Number(input.confidence) } : {}),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
