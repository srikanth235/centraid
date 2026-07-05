/**
 * Expenses and settlements interleaved, newest first, each carrying the
 * owner's role and the display names an entry line needs. The app turns these
 * into "You added … in …" / "Alex paid you …" sentences.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

import { loadTally, personOf } from './dashboard.js';

export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const data = await loadTally(ctx, purpose);
    const me = data.me;
    const groupName = new Map(data.groups.map((g) => [g.group_id, g.name]));
    const rows = [];
    for (const e of data.expenses) {
      const yourShare = e.splits[me] ?? 0;
      let your_role = 'none';
      let your_amount_minor = 0;
      if (e.paid_by === me) {
        your_role = 'lent';
        your_amount_minor = e.amount_minor - yourShare;
      } else if (e.splits[me] != null) {
        your_role = 'borrowed';
        your_amount_minor = yourShare;
      }
      rows.push({
        kind: 'expense',
        date: e.spent_on,
        description: e.description,
        category: e.category,
        group_name: groupName.get(e.group_id) || '',
        paid_by: e.paid_by,
        paid_by_name: personOf(data, e.paid_by).name,
        amount_minor: e.amount_minor,
        your_role,
        your_amount_minor,
      });
    }
    for (const s of data.settlements) {
      rows.push({
        kind: 'settlement',
        date: s.paid_on,
        from_party: s.from_party,
        from_name: personOf(data, s.from_party).name,
        to_party: s.to_party,
        to_name: personOf(data, s.to_party).name,
        amount_minor: s.amount_minor,
      });
    }
    rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return { me, currency: data.currency, activity: rows };
  } catch (err) {
    return {
      me: null,
      currency: 'USD',
      activity: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
