/**
 * Scenario generator (issue #290 phase 1): three friends, one trip group and
 * a lived-in expense ledger — uneven payers, exact splits, one settlement.
 * Balances stay derived (never stored), so the seeded ledger exercises the
 * whole projection. Demo register: `seed.demo` provenance, one-click purge.
 */
const PURPOSE = 'dpv:ServiceProvision';

export default async ({ input, log, ctx }) => {
  const now = new Date(input?.now ?? Date.now()).getTime();
  const day = (n) => new Date(now + n * 86400000).toISOString().slice(0, 10);
  const invoke = async (command, args) => {
    const out = await ctx.vault.invoke({ command, input: args, purpose: PURPOSE });
    if (out.status !== 'executed') {
      throw new Error(`${command} ${out.status}: ${out.reason ?? 'no reason'}`);
    }
    return out.output;
  };

  // The owner is auto-included in every group; expenses need their party id.
  const vaultRow = await ctx.vault.read({ entity: 'core.vault', purpose: PURPOSE, limit: 1 });
  const me = vaultRow.rows?.[0]?.owner_party_id;
  if (!me) throw new Error('vault has no owner party');

  const meera = await invoke('tally.add_friend', { name: 'Meera' });
  const arjun = await invoke('tally.add_friend', { name: 'Arjun' });
  const sana = await invoke('tally.add_friend', { name: 'Sana' });
  const friends = [meera.party_id, arjun.party_id, sana.party_id];

  const group = await invoke('tally.create_group', {
    name: 'Goa Trip',
    icon: 'Palmtree',
    color: 'teal',
    member_ids: friends,
  });

  /** Split `amount` across `parties` exactly — remainder lands on the payer. */
  const even = (amount, parties, payer) => {
    const base = Math.floor(amount / parties.length);
    const splits = parties.map((party_id) => ({ party_id, share_minor: base }));
    const rest = amount - base * parties.length;
    const payerSplit = splits.find((s) => s.party_id === payer) ?? splits[0];
    payerSplit.share_minor += rest;
    return splits;
  };

  const everyone = [me, ...friends];
  const expense = (
    description,
    amount_minor,
    paid_by,
    category,
    spentDaysAgo,
    parties = everyone,
  ) =>
    invoke('tally.add_expense', {
      group_id: group.group_id,
      description,
      amount_minor,
      paid_by,
      category,
      spent_on: day(-spentDaysAgo),
      splits: even(amount_minor, parties, paid_by),
    });

  await expense('Beach shack lunch', 248000, me, 'food', 6);
  await expense('Scooter rentals, 2 days', 160000, arjun.party_id, 'transport', 6);
  await expense('Groceries for the villa', 187550, meera.party_id, 'groceries', 5);
  await expense('Night market', 92000, sana.party_id, 'fun', 4, [
    me,
    meera.party_id,
    sana.party_id,
  ]);
  await expense('Ferry tickets', 60000, me, 'travel', 4);

  await invoke('tally.settle_up', {
    from_party: sana.party_id,
    to_party: me,
    amount_minor: 50000,
    group_id: group.group_id,
    paid_on: day(-2),
  });

  log.info('tally scenario: 3 friends, 1 group, 5 expenses, 1 settlement');
  return { seeded: 10 };
};
