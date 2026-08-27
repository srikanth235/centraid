// The invariants the whole app rests on. Tally derives every figure at read
// time from one fold, so the fold's arithmetic is the product: if a group's
// nets stop summing to zero, or the pairwise view stops agreeing with the
// per-member view, some member is being told a number nobody owes.
//
// Multi-payer expenses are exercised throughout, because that is where a
// per-payer attribution can silently drift from the per-member totals.

import { describe, expect, test } from "vitest";

import type { TallyBalanceData } from "./tally-balance.js";
import {
  attributeExpense,
  expensePayers,
  tallyGroupNet,
  tallyGroupPairNets,
  tallyOpenDebtCount,
} from "./tally-balance.js";

const GROUP = "group-trip";

function data(
  expenses: TallyBalanceData["expenses"],
  settlements: TallyBalanceData["settlements"] = [],
  members: string[] = ["a", "b", "c"]
): TallyBalanceData {
  return {
    membersByGroup: new Map([[GROUP, members]]),
    expenses,
    settlements,
  };
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

describe("expensePayers — the multi-payer compat rule", () => {
  test("no payer rows reads as the single paid_by payer", () => {
    expect(
      expensePayers({
        group_id: GROUP,
        paid_by: "a",
        amount_minor: 900,
        splits: {},
      })
    ).toStrictEqual([["a", 900]]);
  });

  test("declared payers win over paid_by", () => {
    expect(
      expensePayers({
        group_id: GROUP,
        paid_by: "a",
        amount_minor: 900,
        splits: {},
        payers: { a: 600, b: 300 },
      })
    ).toStrictEqual([
      ["a", 600],
      ["b", 300],
    ]);
  });
});

describe("attributeExpense — one attribution rule", () => {
  test("both margins are exact: shares owed out, payments owed back", () => {
    for (const amount of [3, 7, 100, 901, 1_237, 10_003]) {
      const a = Math.floor(amount / 3);
      const b = Math.floor(amount / 3);
      const c = amount - a - b;
      const pa = Math.floor(amount * 0.7);
      const attributions = attributeExpense({
        group_id: GROUP,
        paid_by: "a",
        amount_minor: amount,
        splits: { a, b, c },
        payers: { a: pa, b: amount - pa },
      });
      const owedBy = new Map<string, number>();
      const owedTo = new Map<string, number>();
      for (const row of attributions) {
        owedBy.set(row.from, (owedBy.get(row.from) ?? 0) + row.amount_minor);
        owedTo.set(row.to, (owedTo.get(row.to) ?? 0) + row.amount_minor);
      }
      expect(owedBy.get("a")).toBe(a);
      expect(owedBy.get("b")).toBe(b);
      expect(owedBy.get("c")).toBe(c);
      expect(owedTo.get("a")).toBe(pa);
      expect(owedTo.get("b")).toBe(amount - pa);
    }
  });

  test("a payerless or shareless expense attributes nothing", () => {
    expect(
      attributeExpense({
        group_id: GROUP,
        paid_by: "a",
        amount_minor: 100,
        splits: {},
        payers: { a: 100 },
      })
    ).toStrictEqual([]);
    expect(
      attributeExpense({
        group_id: GROUP,
        paid_by: "a",
        amount_minor: 0,
        splits: { b: 100 },
        payers: { a: 0 },
      })
    ).toStrictEqual([]);
  });
});

describe("a group's per-member positions", () => {
  test("a group's nets always sum to zero, multi-payer included", () => {
    const d = data(
      [
        {
          group_id: GROUP,
          paid_by: "a",
          amount_minor: 901,
          splits: { a: 300, b: 300, c: 301 },
          payers: { a: 500, b: 401 },
        },
        {
          group_id: GROUP,
          paid_by: "c",
          amount_minor: 1000,
          splits: { a: 333, b: 333, c: 334 },
        },
      ],
      [{ group_id: GROUP, from_party: "b", to_party: "a", amount_minor: 250 }]
    );
    expect(sum(tallyGroupNet(d, GROUP).values())).toBe(0);
  });

  test("a member who paid nothing and owes nothing is level, not absent", () => {
    const net = tallyGroupNet(data([]), GROUP);
    // Sorted by party id explicitly: the fold's iteration order is not part of
    // its contract, and a default `sort()` would compare stringified pairs.
    const entries = [...net.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    expect(entries).toStrictEqual([
      ["a", 0],
      ["b", 0],
      ["c", 0],
    ]);
  });

  test("rows outside the group never reach it", () => {
    const d = data([
      {
        group_id: "other-group",
        paid_by: "a",
        amount_minor: 500,
        splits: { a: 250, b: 250 },
      },
      { group_id: null, paid_by: "a", amount_minor: 700, splits: { b: 700 } },
    ]);
    expect(sum(tallyGroupNet(d, GROUP).values())).toBe(0);
    expect(tallyGroupNet(d, GROUP).get("a")).toBe(0);
  });
});

describe("who owes whom inside a group", () => {
  const ledgers: TallyBalanceData[] = [
    data([
      {
        group_id: GROUP,
        paid_by: "a",
        amount_minor: 900,
        splits: { a: 300, b: 300, c: 300 },
      },
    ]),
    data(
      [
        {
          group_id: GROUP,
          paid_by: "a",
          amount_minor: 901,
          splits: { a: 300, b: 300, c: 301 },
          payers: { a: 500, b: 401 },
        },
        {
          group_id: GROUP,
          paid_by: "b",
          amount_minor: 1_237,
          splits: { a: 412, b: 412, c: 413 },
          payers: { b: 1_000, c: 237 },
        },
      ],
      [{ group_id: GROUP, from_party: "c", to_party: "a", amount_minor: 199 }]
    ),
    data(
      [
        {
          group_id: GROUP,
          paid_by: "c",
          amount_minor: 3,
          splits: { a: 1, b: 1, c: 1 },
          payers: { a: 1, b: 1, c: 1 },
        },
      ],
      []
    ),
  ];

  test("the matrix is antisymmetric", () => {
    for (const d of ledgers) {
      const pair = tallyGroupPairNets(d, GROUP);
      for (const [from, row] of pair)
        for (const [to, amount] of row)
          expect(pair.get(to)?.get(from) ?? 0).toBe(-amount);
    }
  });

  test("every row sums to that member's group net", () => {
    for (const d of ledgers) {
      const pair = tallyGroupPairNets(d, GROUP);
      const net = tallyGroupNet(d, GROUP);
      for (const [party, row] of pair) {
        // `pair` is "what I owe", `net` is "what I get back": opposite signs.
        // `+ 0` normalises the negation of zero, which is a distinct value.
        expect(sum(row.values())).toBe(-(net.get(party) ?? 0) + 0);
      }
    }
  });

  test("the whole matrix sums to zero", () => {
    for (const d of ledgers) {
      const pair = tallyGroupPairNets(d, GROUP);
      let total = 0;
      for (const row of pair.values()) total += sum(row.values());
      expect(total).toBe(0);
    }
  });

  test("open debts are the positive half of the matrix", () => {
    const pair = tallyGroupPairNets(ledgers[0]!, GROUP);
    // One payer, three equal shares: b owes a and c owes a. Two debts.
    expect(tallyOpenDebtCount(pair)).toBe(2);
    expect(pair.get("b")?.get("a")).toBe(300);
    expect(pair.get("c")?.get("a")).toBe(300);
  });

  test("a settlement pays a pair debt down rather than inventing one", () => {
    const d = data(
      [
        {
          group_id: GROUP,
          paid_by: "a",
          amount_minor: 900,
          splits: { a: 300, b: 300, c: 300 },
        },
      ],
      [{ group_id: GROUP, from_party: "b", to_party: "a", amount_minor: 300 }]
    );
    const pair = tallyGroupPairNets(d, GROUP);
    expect(pair.get("b")?.get("a")).toBe(0);
    expect(tallyOpenDebtCount(pair)).toBe(1);
  });
});
