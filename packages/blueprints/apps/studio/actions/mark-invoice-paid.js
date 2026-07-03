/**
 * Settle a sent/overdue invoice against an EXISTING core.transaction — a
 * posted credit in the invoice's currency covering its total. Nothing here
 * creates ledger rows: if the deposit isn't tracked in the vault yet, the
 * loop can't close, and the UI says so instead of inventing money.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'business.mark_invoice_paid',
      input: {
        invoice_id: String(input.invoice_id ?? ''),
        txn_id: String(input.txn_id ?? ''),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
