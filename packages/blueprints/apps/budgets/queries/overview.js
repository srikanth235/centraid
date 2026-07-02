/**
 * The budgets projection: recent canonical transactions, the accounts they
 * move through, the owner's budget caps, and the concept vocabulary the
 * category selects are built from. Everything comes from the vault — this
 * app holds no rows of its own; budget progress is computed in the page.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ ctx }) => {
  const purpose = 'dpv:Billing';
  try {
    const [transactions, accounts, budgets, concepts] = await Promise.all([
      ctx.vault.read({ entity: 'core.transaction', limit: 100, purpose }),
      ctx.vault.read({ entity: 'core.account', purpose }),
      ctx.vault.read({ entity: 'finance.budget', purpose }),
      ctx.vault.read({ entity: 'core.concept', purpose }),
    ]);
    // Rows arrive unordered; newest movement first is the ledger's natural
    // reading order.
    const rows = (transactions.rows ?? []).toSorted((a, b) =>
      String(b.posted_at).localeCompare(String(a.posted_at)),
    );
    return {
      transactions: rows,
      accounts: accounts.rows ?? [],
      budgets: budgets.rows ?? [],
      concepts: concepts.rows ?? [],
    };
  } catch (err) {
    return {
      transactions: [],
      accounts: [],
      budgets: [],
      concepts: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
