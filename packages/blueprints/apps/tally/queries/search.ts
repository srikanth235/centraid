/**
 * Match expenses by description, newest first, in the same decorated ledger
 * row shape (with the group name folded in for context). Matching runs
 * server-side over the bounded expense window.
 */

import { ledgerRow, loadTally } from './dashboard.ts';

export default async ({ input, ctx }: HandlerArgs) => {
  const purpose = 'dpv:ServiceProvision';
  const term = String(input?.term ?? '')
    .trim()
    .toLowerCase();
  if (!term) return { me: null, currency: 'USD', results: [] };
  try {
    const data = await loadTally(ctx, purpose);
    const groupName = new Map(data.groups.map((g) => [g.group_id, g.name]));
    const results = data.expenses
      .filter((e) =>
        String(e.description || '')
          .toLowerCase()
          .includes(term),
      )
      .map((e) => ({ ...ledgerRow(data, e), group_name: groupName.get(e.group_id) || '' }));
    return { me: data.me, currency: data.currency, results };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return {
      me: null,
      currency: 'USD',
      results: [],
      vaultDenied: { code: e.code, message: e.message },
    };
  }
};
