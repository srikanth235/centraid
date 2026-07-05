/**
 * One group: its meta, members with derived net balances, and its expense
 * ledger newest-first — each row decorated with the owner's lent/borrowed
 * stance and its per-person splits (so the detail popover needs no second
 * read). All balances come from the shared engine in dashboard.js.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

import { loadTally, groupNet, ledgerRow, personOf } from './dashboard.js';

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const groupId = String(input?.group_id ?? '');
  try {
    const data = await loadTally(ctx, purpose);
    const g = data.groups.find((x) => x.group_id === groupId);
    if (!g) return { me: data.me, currency: data.currency, group: null, members: [], ledger: [] };
    const net = groupNet(data, groupId);
    const members = (data.membersByGroup.get(groupId) ?? []).map((pid) => {
      const p = personOf(data, pid);
      return {
        party_id: pid,
        name: p.name,
        color: p.color,
        initials: p.initials,
        is_me: p.is_me,
        net_minor: net.get(pid) || 0,
      };
    });
    const ledger = data.expenses
      .filter((e) => e.group_id === groupId)
      .map((e) => ledgerRow(data, e));
    return {
      me: data.me,
      currency: data.currency,
      group: { group_id: g.group_id, name: g.name, icon: g.icon, color: g.color },
      members,
      ledger,
    };
  } catch (err) {
    return {
      me: null,
      currency: 'USD',
      group: null,
      members: [],
      ledger: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
