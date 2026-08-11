/** The minimal resident facts consumed by Tally's balance fold. Keeping this
 * pure makes the same computation usable by the shipped query and by
 * convergence tests without projecting a balance row across Commons. */
export interface TallyBalanceData {
  membersByGroup: ReadonlyMap<string, readonly string[]>;
  expenses: readonly {
    group_id: string;
    paid_by: string;
    amount_minor: number;
    splits: Readonly<Record<string, number>>;
  }[];
  settlements: readonly {
    group_id?: string;
    from_party: string;
    to_party: string;
    amount_minor: number;
  }[];
}

/** Net per member within a group, in minor units. Positive = gets money back. */
export function tallyGroupNet(
  data: TallyBalanceData,
  groupId: string
): Map<string, number> {
  const net = new Map<string, number>();
  for (const partyId of data.membersByGroup.get(groupId) ?? [])
    net.set(partyId, 0);
  for (const expense of data.expenses) {
    if (expense.group_id !== groupId) continue;
    net.set(
      expense.paid_by,
      (net.get(expense.paid_by) || 0) + expense.amount_minor
    );
    for (const [partyId, share] of Object.entries(expense.splits))
      net.set(partyId, (net.get(partyId) || 0) - share);
  }
  for (const settlement of data.settlements) {
    if (settlement.group_id !== groupId) continue;
    net.set(
      settlement.from_party,
      (net.get(settlement.from_party) || 0) + settlement.amount_minor
    );
    net.set(
      settlement.to_party,
      (net.get(settlement.to_party) || 0) - settlement.amount_minor
    );
  }
  return net;
}
