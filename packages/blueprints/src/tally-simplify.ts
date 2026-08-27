/** Pure and read-time: no proposal table, no stored balance. Simplification
 *  is OFF unless a group opts in. */

import type { TallyBalanceData } from "./tally-balance.js";
import {
  tallyGroupNet,
  tallyGroupPairNets,
  tallyOpenDebtCount,
} from "./tally-balance.js";

export interface TallyTransfer {
  from: string;
  to: string;
  amount_minor: number;
}

export interface TallySimplification {
  opted_in: boolean;
  transfers: TallyTransfer[];
  debts_before: number;
  payments_after: number;
}

/** Min-cash-flow: each transfer zeroes a party, so at most `n - 1` payments;
 *  integer minor units, so it terminates. */
export function minimalTransfers(
  net: ReadonlyMap<string, number>
): TallyTransfer[] {
  const debtors: Array<[string, number]> = [];
  const creditors: Array<[string, number]> = [];
  for (const [partyId, amount] of net) {
    if (amount < 0) debtors.push([partyId, -amount]);
    else if (amount > 0) creditors.push([partyId, amount]);
  }
  // Deterministic order: a proposal must not reshuffle between reads.
  const bySize = (a: [string, number], b: [string, number]): number =>
    b[1] - a[1] || a[0].localeCompare(b[0]);
  debtors.sort(bySize);
  creditors.sort(bySize);

  const transfers: TallyTransfer[] = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const debtor = debtors[d]!;
    const creditor = creditors[c]!;
    const amount = Math.min(debtor[1], creditor[1]);
    if (amount > 0)
      transfers.push({
        from: debtor[0],
        to: creditor[0],
        amount_minor: amount,
      });
    debtor[1] -= amount;
    creditor[1] -= amount;
    if (debtor[1] === 0) d += 1;
    if (creditor[1] === 0) c += 1;
  }
  return transfers;
}

export function tallySimplification(
  data: TallyBalanceData,
  groupId: string,
  optedIn: boolean
): TallySimplification {
  const debtsBefore = tallyOpenDebtCount(tallyGroupPairNets(data, groupId));
  if (!optedIn)
    return {
      opted_in: false,
      transfers: [],
      debts_before: debtsBefore,
      payments_after: debtsBefore,
    };
  const transfers = minimalTransfers(tallyGroupNet(data, groupId));
  return {
    opted_in: true,
    transfers,
    debts_before: debtsBefore,
    payments_after: transfers.length,
  };
}
