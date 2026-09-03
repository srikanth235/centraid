export interface TallyBalanceExpense {
  group_id: string | null;
  paid_by: string;
  amount_minor: number;
  splits: Readonly<Record<string, number>>;
  payers: Readonly<Record<string, number>>;
}

export interface TallyBalanceData {
  membersByGroup: ReadonlyMap<string, readonly string[]>;
  expenses: readonly TallyBalanceExpense[];
  settlements: readonly {
    group_id?: string | null;
    from_party: string;
    to_party: string;
    amount_minor: number;
  }[];
}

export function expensePayers(
  expense: TallyBalanceExpense
): Array<[string, number]> {
  return Object.entries(expense.payers).filter(([, paid]) => paid !== 0);
}

export interface TallyAttribution {
  from: string;
  to: string;
  amount_minor: number;
}

export function attributeExpense(
  expense: TallyBalanceExpense
): TallyAttribution[] {
  const order = (
    a: readonly [string, number],
    b: readonly [string, number]
  ): number => b[1] - a[1] || a[0].localeCompare(b[0]);
  const payers = expensePayers(expense)
    .filter(([, paid]) => paid > 0)
    .sort(order);
  const participants = Object.entries(expense.splits)
    .filter(([, share]) => share > 0)
    .sort(order);

  const attributions: TallyAttribution[] = [];
  let owing = 0;
  let paying = 0;
  let shareLeft = participants[0]?.[1] ?? 0;
  let paidLeft = payers[0]?.[1] ?? 0;
  while (owing < participants.length && paying < payers.length) {
    const amount = Math.min(shareLeft, paidLeft);
    if (amount <= 0) break;
    attributions.push({
      from: participants[owing]![0],
      to: payers[paying]![0],
      amount_minor: amount,
    });
    shareLeft -= amount;
    paidLeft -= amount;
    if (shareLeft === 0) {
      owing += 1;
      shareLeft = participants[owing]?.[1] ?? 0;
    }
    if (paidLeft === 0) {
      paying += 1;
      paidLeft = payers[paying]?.[1] ?? 0;
    }
  }
  return attributions;
}

export function tallyGroupNet(
  data: TallyBalanceData,
  groupId: string
): Map<string, number> {
  const net = new Map<string, number>();
  for (const partyId of data.membersByGroup.get(groupId) ?? [])
    net.set(partyId, 0);
  for (const expense of data.expenses) {
    if (expense.group_id !== groupId) continue;
    for (const [partyId, paid] of expensePayers(expense))
      net.set(partyId, (net.get(partyId) || 0) + paid);
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

export function tallyGroupPairNets(
  data: TallyBalanceData,
  groupId: string
): Map<string, Map<string, number>> {
  const pair = new Map<string, Map<string, number>>();
  const owe = (from: string, to: string, amount: number): void => {
    if (from === to || amount === 0) return;
    if (!pair.has(from)) pair.set(from, new Map());
    if (!pair.has(to)) pair.set(to, new Map());
    const forward = pair.get(from)!;
    const back = pair.get(to)!;
    forward.set(to, (forward.get(to) || 0) + amount);
    back.set(from, (back.get(from) || 0) - amount);
  };
  for (const partyId of data.membersByGroup.get(groupId) ?? [])
    if (!pair.has(partyId)) pair.set(partyId, new Map());

  for (const expense of data.expenses) {
    if (expense.group_id !== groupId) continue;
    for (const attribution of attributeExpense(expense))
      owe(attribution.from, attribution.to, attribution.amount_minor);
  }
  for (const settlement of data.settlements) {
    if (settlement.group_id !== groupId) continue;
    owe(settlement.from_party, settlement.to_party, -settlement.amount_minor);
  }
  return pair;
}

export function tallyOpenDebtCount(
  pair: ReadonlyMap<string, ReadonlyMap<string, number>>
): number {
  let count = 0;
  for (const row of pair.values())
    for (const amount of row.values()) if (amount > 0) count += 1;
  return count;
}
