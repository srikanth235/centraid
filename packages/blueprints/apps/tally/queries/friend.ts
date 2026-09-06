/**
 * One friend: the net balance with them (positive = they owe you) and the
 * expenses you both took part in, newest first, decorated like a group ledger.
 */

import { EMPTY_BAG, money } from "@centraid/core/money";
import type { Money } from "@centraid/core/money";

import { attributeExpense } from "../../../src/tally-balance.ts";
import {
  deniedPayload,
  expenseCurrency,
  groupCurrency,
  ledgerRow,
  loadTally,
  pairwise,
  personOf,
} from "./dashboard.ts";

/**
 * The friend's net, broken down by where it came from: one part per group plus
 * "outside any group" for the group-less 1:1 rows. Same fold as `pairwise`,
 * scoped — the parts sum to the whole net, which is the only claim the hero
 * makes about them.
 */
function netParts(
  data: Awaited<ReturnType<typeof loadTally>>,
  friendId: string
): Array<{ group_id: string | null; group_name: string; net: Money }> {
  const me = data.me;
  if (me == null) return [];
  // EACH PART IS IN ITS GROUP'S MONEY (#996, ruling R22). The parts used to be
  // bare minor units and the hero rendered them under the vault's base
  // currency, so a part from a EUR group and a part from a USD group appeared
  // to be the same kind of number.
  const byGroup = new Map<string | null, number>();
  const add = (groupId: string | null, amount: number): void => {
    byGroup.set(groupId, (byGroup.get(groupId) ?? 0) + amount);
  };
  const outsideCurrency = new Map<string | null, string>();
  const noteCurrency = (groupId: string | null, currency: string): void => {
    if (!outsideCurrency.has(groupId)) outsideCurrency.set(groupId, currency);
  };
  for (const expense of data.expenses)
    for (const { from, to, amount_minor } of attributeExpense(expense)) {
      if (from === to) continue;
      if (to === me && from === friendId) {
        add(expense.group_id, amount_minor);
        noteCurrency(expense.group_id, expenseCurrency(data, expense));
      } else if (from === me && to === friendId) {
        add(expense.group_id, -amount_minor);
        noteCurrency(expense.group_id, expenseCurrency(data, expense));
      }
    }
  for (const settlement of data.settlements) {
    const groupId = (settlement.group_id as string | undefined) ?? null;
    const currency = settlement.currency ?? groupCurrency(data, groupId);
    if (settlement.from_party === me && settlement.to_party === friendId) {
      add(groupId, settlement.amount_minor);
      noteCurrency(groupId, currency);
    } else if (
      settlement.to_party === me &&
      settlement.from_party === friendId
    ) {
      add(groupId, -settlement.amount_minor);
      noteCurrency(groupId, currency);
    }
  }
  for (const obligation of data.obligations) {
    // A standing IOU is never group-scoped, so it lands outside any group.
    if (obligation.from_party === me && obligation.to_party === friendId) {
      add(null, -obligation.amount_minor);
      noteCurrency(null, obligation.currency);
    } else if (
      obligation.to_party === me &&
      obligation.from_party === friendId
    ) {
      add(null, obligation.amount_minor);
      noteCurrency(null, obligation.currency);
    }
  }
  const groupName = new Map(
    data.groups.map((group) => [group.group_id, group.name])
  );
  return [...byGroup.entries()]
    .filter(([, net]) => net !== 0)
    .map(([groupId, net]) => ({
      group_id: groupId,
      group_name:
        groupId === null
          ? "Outside any group"
          : (groupName.get(groupId) ?? "Group"),
      net: money(
        net,
        outsideCurrency.get(groupId) ?? groupCurrency(data, groupId)
      ),
    }))
    .sort((a, b) => a.group_name.localeCompare(b.group_name));
}

export default async function friendHandler({ input, ctx }: HandlerArgs) {
  const pid = String(input?.party_id ?? "");
  try {
    const data = await loadTally(ctx);
    if (!data.people.has(pid) || pid === data.me) {
      return { me: data.me, currency: data.currency, friend: null, ledger: [] };
    }
    const p = personOf(data, pid);
    const net = pairwise(data).get(pid) ?? EMPTY_BAG;
    const me = data.me;
    const ledger = data.expenses
      .filter(
        (e) =>
          e.splits[pid] != null &&
          me != null &&
          e.splits[me] != null &&
          (e.paid_by === pid || e.paid_by === me)
      )
      .map((e) => ledgerRow(data, e));
    return {
      me,
      currency: data.currency,
      friend: {
        party_id: pid,
        name: p.name,
        color: p.color,
        initials: p.initials,
        balances: [...net],
        parts: netParts(data, pid),
      },
      ledger,
    };
  } catch (error) {
    return {
      me: null,
      currency: "USD",
      friend: null,
      ledger: [],
      vaultDenied: deniedPayload(error),
    };
  }
}
