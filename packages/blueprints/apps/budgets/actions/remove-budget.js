/**
 * Delete a spending cap through the vault's typed command. Only the cap
 * goes — the ledger is untouched, because a budget is a limit over
 * spending, never spending itself. Outcome passed through for the UI to
 * narrate (and to offer Undo via set-budget).
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'finance.remove_budget',
      input: { budget_id: String(input.budget_id ?? '') },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
