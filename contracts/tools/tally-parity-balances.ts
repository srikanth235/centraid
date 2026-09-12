// The balance engine's parity cases (#1020, wave 2 lane D3).
//
// Split out of `export-tally-parity.ts` because it is the one half of the
// bundle that touches no vault: pure maps in, pure maps out, which is why it is
// also the one half the phone imports directly (#922 E7, ruling SB-tally).
//
// Each case names the claim it pins in the words the fold's own doctrine uses,
// so a Rust port that disagrees about an answer can read what the answer was
// supposed to mean.

import {
  attributeExpense,
  tallyGroupNet,
  tallyGroupPairNets,
  tallyOpenDebtCount,
} from "../../packages/blueprints/src/tally-balance.ts";
import type { TallyBalanceData } from "../../packages/blueprints/src/tally-balance.ts";
import {
  minimalTransfers,
  tallySimplification,
} from "../../packages/blueprints/src/tally-simplify.ts";

/**
 * The engine's input, as plain JSON.
 *
 * `TallyBalanceData.membersByGroup` is a `Map`, and a Map does not survive
 * `JSON.stringify`. The reshaping happens HERE, next to the fold that consumes
 * it, rather than in the oracle test: the engine's Map signature is the one the
 * phone imports directly (#922 E7, ruling SB-tally), and a fixture must not
 * reshape the thing it pins.
 */
export interface BalanceInput {
  members_by_group: [string, string[]][];
  expenses: TallyBalanceData["expenses"];
  settlements: TallyBalanceData["settlements"];
}

export interface BalanceCase {
  case: string;
  /** What the case is checking, in the words the fold's doctrine uses. */
  claim: string;
  data: BalanceInput;
  group_id: string;
  currency: string;
  expected: unknown;
}

/**
 * The balance engine's cases, as inputs and answers.
 *
 * Pure in, pure out: no vault reaches this half, which is why it is the one
 * part of Tally the phone already imports directly (#922 E7, ruling SB-tally).
 */
export function balanceCases(): BalanceCase[] {
  const data = (
    members: Record<string, string[]>,
    expenses: TallyBalanceData["expenses"],
    settlements: TallyBalanceData["settlements"] = []
  ): TallyBalanceData => ({
    membersByGroup: new Map(Object.entries(members)),
    expenses,
    settlements,
  });

  const cases: {
    case: string;
    claim: string;
    data: TallyBalanceData;
    groupId: string;
    currency: string;
  }[] = [
    {
      case: "odd-amount-three-ways",
      claim:
        "matching off exhausts both sides exactly, with no remainder to place",
      data: data({ g: ["me", "a", "b"] }, [
        {
          group_id: "g",
          paid_by: "me",
          amount_minor: 10_001,
          splits: { me: 3_334, a: 3_334, b: 3_333 },
          payers: { me: 10_001 },
        },
      ]),
      groupId: "g",
      currency: "GBP",
    },
    {
      case: "two-payers",
      claim:
        "every pair row sums to that member's net with the sign flipped, so the pairwise view is a refinement and not a second opinion",
      data: data({ g: ["me", "a", "b"] }, [
        {
          group_id: "g",
          paid_by: "a",
          amount_minor: 24_000,
          splits: { me: 8_000, a: 8_000, b: 8_000 },
          payers: { a: 14_000, b: 10_000 },
        },
      ]),
      groupId: "g",
      currency: "GBP",
    },
    {
      case: "settlement-reduces-what-you-owe",
      claim: "paying someone reduces what you owe them and nothing else",
      data: data(
        { g: ["me", "a"] },
        [
          {
            group_id: "g",
            paid_by: "me",
            amount_minor: 10_000,
            splits: { me: 5_000, a: 5_000 },
            payers: { me: 10_000 },
          },
        ],
        [
          {
            group_id: "g",
            from_party: "a",
            to_party: "me",
            amount_minor: 5_000,
          },
        ]
      ),
      groupId: "g",
      currency: "GBP",
    },
    {
      case: "zero-share-does-not-participate",
      claim: "only positive shares and positive payments participate",
      data: data({ g: ["me", "a", "b"] }, [
        {
          group_id: "g",
          paid_by: "me",
          amount_minor: 6_000,
          splits: { me: 3_000, a: 3_000, b: 0 },
          payers: { me: 6_000, a: 0 },
        },
      ]),
      groupId: "g",
      currency: "GBP",
    },
    {
      case: "departed-member-still-owes",
      claim:
        "circle membership is current state and the ledger is durable history, so a member who left is still on the matrix",
      data: data({ g: ["me", "a"] }, [
        {
          group_id: "g",
          paid_by: "me",
          amount_minor: 9_000,
          splits: { me: 3_000, a: 3_000, gone: 3_000 },
          payers: { me: 9_000 },
        },
      ]),
      groupId: "g",
      currency: "GBP",
    },
    {
      case: "four-way-simplification",
      claim:
        "each transfer zeroes a party, so at most n-1 payments, and the order does not reshuffle between reads",
      data: data({ g: ["me", "a", "b", "c"] }, [
        {
          group_id: "g",
          paid_by: "me",
          amount_minor: 12_000,
          splits: { me: 3_000, a: 3_000, b: 3_000, c: 3_000 },
          payers: { me: 12_000 },
        },
        {
          group_id: "g",
          paid_by: "a",
          amount_minor: 8_000,
          splits: { a: 2_000, b: 3_000, c: 3_000 },
          payers: { a: 8_000 },
        },
      ]),
      groupId: "g",
      currency: "GBP",
    },
  ];

  return cases.map((entry) => {
    const net = tallyGroupNet(entry.data, entry.groupId);
    const pair = tallyGroupPairNets(entry.data, entry.groupId);
    return {
      case: entry.case,
      claim: entry.claim,
      group_id: entry.groupId,
      currency: entry.currency,
      data: {
        members_by_group: [...entry.data.membersByGroup.entries()],
        expenses: entry.data.expenses,
        settlements: entry.data.settlements,
      },
      expected: {
        attributions: entry.data.expenses
          .filter((expense) => expense.group_id === entry.groupId)
          .map((expense) => attributeExpense(expense)),
        net: [...net.entries()].sort(([left], [right]) =>
          left < right ? -1 : 1
        ),
        pairwise: [...pair.entries()]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([party, row]) => [
            party,
            [...row.entries()].sort(([left], [right]) =>
              left < right ? -1 : 1
            ),
          ]),
        open_debts: tallyOpenDebtCount(pair),
        minimal_transfers: minimalTransfers(net, entry.currency),
        simplification_off: tallySimplification(
          entry.data,
          entry.groupId,
          false,
          entry.currency
        ),
        simplification_on: tallySimplification(
          entry.data,
          entry.groupId,
          true,
          entry.currency
        ),
      },
    };
  });
}
