/**
 * One friend: the net balance with them (positive = they owe you) and the
 * expenses you both took part in, newest first, decorated like a group ledger.
 *
 * @type {import('@centraid/app-engine').QueryHandler}
 */

import { loadTally, pairwise, ledgerRow, personOf } from './dashboard.js';

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const pid = String(input?.party_id ?? '');
  try {
    const data = await loadTally(ctx, purpose);
    if (!data.people.has(pid) || pid === data.me) {
      return { me: data.me, currency: data.currency, friend: null, ledger: [] };
    }
    const p = personOf(data, pid);
    const net = pairwise(data).get(pid) || 0;
    const me = data.me;
    const ledger = data.expenses
      .filter(
        (e) =>
          e.splits[pid] != null && e.splits[me] != null && (e.paid_by === pid || e.paid_by === me),
      )
      .map((e) => ledgerRow(data, e));
    return {
      me,
      currency: data.currency,
      friend: { party_id: pid, name: p.name, color: p.color, initials: p.initials, net_minor: net },
      ledger,
    };
  } catch (err) {
    return {
      me: null,
      currency: 'USD',
      friend: null,
      ledger: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
