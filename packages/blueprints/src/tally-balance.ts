/** The minimal resident facts consumed by Tally's balance fold. Keeping this
 * pure makes the same computation usable by the shipped query and by
 * convergence tests without projecting a balance row across Commons. */
export interface TallyBalanceExpense {
  group_id: string | null;
  paid_by: string;
  amount_minor: number;
  splits: Readonly<Record<string, number>>;
  /**
   * Who actually put money down, in minor units. REQUIRED (#883, ruling
   * O-payers): every expense carries payer rows, so a caller that cannot
   * supply them is reading the wrong thing.
   */
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

/**
 * Who paid what on one expense, zero-contributions dropped. Payer rows are
 * ground facts (#883, ruling O-payers): a fold that finds none is reading an
 * expense the vault never finished writing, and must show that rather than
 * invent a fallback.
 */
export function expensePayers(
  expense: TallyBalanceExpense
): Array<[string, number]> {
  return Object.entries(expense.payers).filter(([, paid]) => paid !== 0);
}

/** One participant owing one payer, in minor units. */
export interface TallyAttribution {
  from: string;
  to: string;
  amount_minor: number;
}

/**
 * Who owes whom for ONE expense. THE single attribution rule — every pairwise
 * view calls this, so no two can disagree about who a share is owed to.
 *
 * Shares and payments are matched off in a fixed order (largest first, then by
 * party id) rather than pro-rated: pro-rating rounds per share, the rounded
 * portions stop adding back to what each payer put down, and the pairwise view
 * stops reconciling with the per-member fold. Matching off exhausts both sides
 * exactly, with no remainder to place.
 */
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

/**
 * Who owes whom inside a group, before any simplification. `pair.get(a).get(b)`
 * is positive when **a owes b**; the matrix is antisymmetric by construction.
 *
 * This is a REFINEMENT of `tallyGroupNet`, never a second opinion: a
 * participant's share of an expense is attributed to each payer in proportion
 * to what that payer put down, so every row sums to exactly that member's
 * `tallyGroupNet` position with the sign flipped (`tally-balance.test.ts`
 * pins that reconciliation). The odd penny of a proportional attribution goes
 * to the largest payer, which keeps the row sums integral.
 */
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
    // Paying someone reduces what you owe them.
    owe(settlement.from_party, settlement.to_party, -settlement.amount_minor);
  }
  return pair;
}

/** How many directed debts stand between members of the group right now. */
export function tallyOpenDebtCount(
  pair: ReadonlyMap<string, ReadonlyMap<string, number>>
): number {
  let count = 0;
  for (const row of pair.values())
    for (const amount of row.values()) if (amount > 0) count += 1;
  return count;
}
