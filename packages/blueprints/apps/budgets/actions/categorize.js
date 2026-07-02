/**
 * Recategorize a transaction through the vault's typed command. This is a
 * classification change with provenance — the amount is unreachable by
 * construction, no command exposes it. The outcome is passed through
 * verbatim — `executed`, `parked` (awaiting owner confirmation), `denied`,
 * or `failed` (a precondition such as the txn/category existence checks) —
 * so the UI can narrate what the consent plane decided.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'finance.categorize_txn',
      input: {
        txn_id: String(input.txn_id ?? ''),
        category_concept_id: String(input.category_concept_id ?? ''),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
