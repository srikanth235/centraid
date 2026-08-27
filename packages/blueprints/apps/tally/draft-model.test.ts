// What a member is composing, and what it turns into.
//
// WHAT IS PINNED HERE. *No group* is a real choice now — `tally.add_expense`
// has `group_id` optional and checks a group-less expense's participants
// against the friend roster — so the input OMITS the field rather than nulling
// it. Several payers must put down exactly the expense. A write carries ONLY
// the fields its schema declares, so a currency provenance that is
// half-supplied travels as nothing at all rather than as a rate the vault
// would reject. And an edit re-opens the DIVISION that was recorded, with the
// numbers that produced the shares, rather than collapsing to exact amounts.
import { describe, expect, it } from "vitest";

import {
  CATEGORIES,
  addExpenseInput,
  draftFromEntry,
  editExpenseInput,
  entryValues,
  expenseVerdict,
  newExpenseDraft,
  newSettleDraft,
  parseMoney,
  parseRate,
  prefillEntries,
  settleInput,
  settlementMinor,
  settleVerdict,
} from "./draft-model.ts";
import type { ExpenseDraft } from "./draft-model.ts";

const THREE = ["me", "ana", "tom"];

function draft(over: Partial<ExpenseDraft> = {}): ExpenseDraft {
  return {
    ...newExpenseDraft({
      groupId: "flat",
      payerId: "me",
      today: "2026-08-26",
      currency: "GBP",
    }),
    description: "Weekly shop",
    amount: "100.00",
    ...over,
  };
}

describe("the nine categories, closed", () => {
  it("is exactly the vault's own enum", () => {
    expect(CATEGORIES.map(([id]) => id)).toStrictEqual([
      "food",
      "groceries",
      "rent",
      "utilities",
      "transport",
      "fun",
      "travel",
      "shopping",
      "general",
    ]);
  });
});

describe("reading what was typed", () => {
  it.each([
    ["84.20", 8420],
    ["1,450", 145_000],
    ["0", 0],
  ])("reads %s as %d minor units", (text, minor) => {
    expect(parseMoney(text)).toBe(minor);
  });

  it.each(["", "  ", "abc", "-4"])("reads %s as nothing typed", (text) => {
    expect(parseMoney(text)).toBeNull();
  });

  it("scales a supplied rate to fixed point", () => {
    expect(parseRate("1.1636")).toStrictEqual({
      rate_scaled: 1_163_600,
      rate_scale: 6,
    });
    expect(parseRate("0")).toBeNull();
    expect(parseRate("")).toBeNull();
  });

  it("reads a cell in the unit its division is typed in", () => {
    expect(entryValues("exact", { me: "33.34" })).toStrictEqual({ me: 3334 });
    expect(entryValues("adjust", { me: "-5.00" })).toStrictEqual({ me: -500 });
    expect(entryValues("percent", { me: "40" })).toStrictEqual({ me: 40 });
    expect(entryValues("shares", { me: "2" })).toStrictEqual({ me: 2 });
  });

  it("pre-fills a table in the unit the member will edit", () => {
    expect(prefillEntries("exact", 10_000, THREE, "me")).toStrictEqual({
      me: "33.34",
      ana: "33.33",
      tom: "33.33",
    });
    expect(prefillEntries("shares", 10_000, THREE, "me")).toStrictEqual({
      me: "1",
      ana: "1",
      tom: "1",
    });
  });
});

describe("what the expense comes to", () => {
  it("is what was typed, when it was typed in the settlement currency", () => {
    expect(settlementMinor(draft())).toBe(10_000);
  });

  it("is derived from the rate the MEMBER supplied, and nothing looks one up", () => {
    // €249.00 at 1.1636 — the design file's own hire car — is £213.99, and
    // the rate the member supplied is the only thing that decides it.
    expect(
      settlementMinor(
        draft({
          amount: "249.00",
          foreign: true,
          currency: "EUR",
          rate: "1.1636",
        })
      )
    ).toBe(21_399);
  });

  it("is unknowable without a rate, and says so by being null", () => {
    expect(
      settlementMinor(draft({ foreign: true, currency: "EUR", rate: "" }))
    ).toBeNull();
  });
});

describe("whether an expense can be written", () => {
  it("commits an equal split of a whole draft", () => {
    const verdict = expenseVerdict(draft(), THREE, "GBP");
    expect(verdict.ok).toBe(true);
    expect(verdict.splits).toStrictEqual([
      { party_id: "me", share_minor: 3334 },
      { party_id: "ana", share_minor: 3333 },
      { party_id: "tom", share_minor: 3333 },
    ]);
  });

  it.each([
    ["a description", { description: "  " }],
    ["an amount", { amount: "" }],
    ["an amount above zero", { amount: "0" }],
  ])("refuses without %s", (_label, over) => {
    expect(expenseVerdict(draft(over), THREE, "GBP").ok).toBe(false);
  });

  it("takes *No group* — a group-less 1:1 is a write, not a refusal", () => {
    const verdict = expenseVerdict(draft({ groupId: null }), THREE, "GBP");
    expect(verdict.ok).toBe(true);
    expect(verdict.refusal).toBeUndefined();
  });

  it("refuses a foreign currency with no rate, or a code that is not a code", () => {
    expect(
      expenseVerdict(
        draft({ foreign: true, currency: "EUR", rate: "" }),
        THREE,
        "GBP"
      ).refusal
    ).toContain("rate");
    expect(
      expenseVerdict(
        draft({ foreign: true, currency: "Euros", rate: "1.1" }),
        THREE,
        "GBP"
      ).refusal
    ).toContain("three-letter");
  });

  it("commits weights, and hands the odd penny to the payer", () => {
    const verdict = expenseVerdict(
      draft({ division: "shares", entries: { me: "2", ana: "1", tom: "1" } }),
      THREE,
      "GBP"
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.splits).toStrictEqual([
      { party_id: "me", share_minor: 5000 },
      { party_id: "ana", share_minor: 2500 },
      { party_id: "tom", share_minor: 2500 },
    ]);
  });

  it("refuses weights that weigh nothing", () => {
    const verdict = expenseVerdict(
      draft({ division: "shares", entries: { me: "0", ana: "0", tom: "0" } }),
      THREE,
      "GBP"
    );
    expect(verdict.ok).toBe(false);
  });

  it("commits an adjusted split only when the adjustments come back to the total", () => {
    const level = expenseVerdict(
      draft({
        division: "adjust",
        entries: { me: "5.00", ana: "-5.00", tom: "0" },
      }),
      THREE,
      "GBP"
    );
    expect(level.ok).toBe(true);
    expect(level.splits.reduce((sum, s) => sum + s.share_minor, 0)).toBe(
      10_000
    );
    const off = expenseVerdict(
      draft({
        division: "adjust",
        entries: { me: "5.00", ana: "0", tom: "0" },
      }),
      THREE,
      "GBP"
    );
    expect(off.ok).toBe(false);
  });

  it("commits typed lines that sum to the expense, and refuses ones that do not", () => {
    const lines = [
      {
        lineId: "a",
        kind: "item" as const,
        description: "Wine",
        amount: "60.00",
        who: ["me", "ana"],
      },
      {
        lineId: "b",
        kind: "item" as const,
        description: "Food",
        amount: "40.00",
        who: ["tom"],
      },
    ];
    const ok = expenseVerdict(
      draft({ division: "lines", lines }),
      THREE,
      "GBP"
    );
    expect(ok.ok).toBe(true);
    expect(ok.splits).toStrictEqual([
      { party_id: "me", share_minor: 3000 },
      { party_id: "ana", share_minor: 3000 },
      { party_id: "tom", share_minor: 4000 },
    ]);
    expect(ok.lineItems).toHaveLength(2);
    const short = expenseVerdict(
      draft({ division: "lines", lines: [lines[0]!] }),
      THREE,
      "GBP"
    );
    expect(short.ok).toBe(false);
  });

  it("refuses payers who put down more or less than the expense", () => {
    const out = expenseVerdict(
      draft({ payers: { me: "60.00", ana: "20.00" } }),
      THREE,
      "GBP"
    );
    expect(out.ok).toBe(false);
    expect(out.refusal).toContain("more or less");
  });

  it("takes several payers whose parts sum to the expense", () => {
    const use = draft({ payers: { me: "60.00", ana: "40.00" } });
    const out = expenseVerdict(use, THREE, "GBP");
    expect(out.ok).toBe(true);
    expect(out.payers).toStrictEqual([
      { party_id: "me", paid_minor: 6000 },
      { party_id: "ana", paid_minor: 4000 },
    ]);
  });

  it("hands an unbalanced percentage split its own reconcile line as the reason", () => {
    const verdict = expenseVerdict(
      draft({
        division: "percent",
        entries: { me: "40", ana: "35", tom: "24" },
      }),
      THREE,
      "GBP"
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.refusal).toContain("it will not commit at 99");
  });
});

describe("the input a write carries", () => {
  it("is exactly what `add-expense` declares", () => {
    const use = draft();
    const verdict = expenseVerdict(use, THREE, "GBP");
    expect(addExpenseInput(use, verdict, "GBP")).toStrictEqual({
      group_id: "flat",
      description: "Weekly shop",
      amount_minor: 10_000,
      paid_by: "me",
      category: "general",
      splits: verdict.splits,
      payers: [{ party_id: "me", paid_minor: 10_000 }],
      split_method: "equally",
      spent_on: "2026-08-26",
    });
  });

  it("omits the group entirely on a group-less 1:1, rather than nulling it", () => {
    const use = draft({ groupId: null });
    const input = addExpenseInput(
      use,
      expenseVerdict(use, THREE, "GBP"),
      "GBP"
    );
    expect(input).not.toHaveProperty("group_id");
  });

  it("names the largest payer as `paid_by` and carries the rest in `payers`", () => {
    const use = draft({ payers: { ana: "70.00", me: "30.00" } });
    const input = addExpenseInput(
      use,
      expenseVerdict(use, THREE, "GBP"),
      "GBP"
    );
    expect(input.paid_by).toBe("ana");
    expect(input.payers).toStrictEqual([
      { party_id: "ana", paid_minor: 7000 },
      { party_id: "me", paid_minor: 3000 },
    ]);
  });

  it("records the method, and the numbers that produced the shares", () => {
    const use = draft({
      division: "percent",
      entries: { me: "50", ana: "30", tom: "20" },
    });
    const input = addExpenseInput(
      use,
      expenseVerdict(use, THREE, "GBP"),
      "GBP"
    );
    expect(input.split_method).toBe("percentages");
    expect(input.split_params).toStrictEqual({
      unit: "percent",
      entries: { me: 50, ana: 30, tom: 20 },
    });
  });

  it("carries typed lines, and no `split_params`, under *By line*", () => {
    const use = draft({
      division: "lines",
      lines: [
        {
          lineId: "a",
          kind: "item",
          description: "Wine",
          amount: "100.00",
          who: ["me", "ana"],
        },
      ],
    });
    const input = addExpenseInput(
      use,
      expenseVerdict(use, THREE, "GBP"),
      "GBP"
    );
    expect(input.split_method).toBe("by_line");
    expect(input).not.toHaveProperty("split_params");
    expect(input.line_items).toStrictEqual([
      {
        kind: "item",
        description: "Wine",
        amount_minor: 10_000,
        allocations: [
          { party_id: "me", share_minor: 5000 },
          { party_id: "ana", share_minor: 5000 },
        ],
      },
    ]);
  });

  it("carries no currency provenance where there is none to carry", () => {
    const use = draft();
    const input = addExpenseInput(
      use,
      expenseVerdict(use, THREE, "GBP"),
      "GBP"
    );
    expect(input).not.toHaveProperty("rate_scaled");
    expect(input).not.toHaveProperty("original_currency");
  });

  it("carries the rate, its source and its date where a member supplied them", () => {
    const use = draft({
      amount: "249.00",
      foreign: true,
      currency: "eur",
      rate: "1.1636",
      rateSource: "read off the receipt",
      rateDate: "2026-06-14",
    });
    const input = addExpenseInput(
      use,
      expenseVerdict(use, THREE, "GBP"),
      "GBP"
    );
    expect(input).toMatchObject({
      amount_minor: 21_399,
      original_amount_minor: 24_900,
      original_currency: "EUR",
      settlement_currency: "GBP",
      rate_scaled: 1_163_600,
      rate_scale: 6,
      rate_source: "read off the receipt",
      rate_date: "2026-06-14",
    });
  });

  it("keys an edit by the expense and drops the group the command does not take", () => {
    const use = draft({ expenseId: "x1" });
    const input = editExpenseInput(
      use,
      expenseVerdict(use, THREE, "GBP"),
      "GBP"
    );
    expect(input.expense_id).toBe("x1");
    expect(input).not.toHaveProperty("group_id");
  });
});

describe("re-opening an expense as a draft", () => {
  const entry = {
    expense_id: "x6",
    group_id: "coast",
    description: "Hire car, three days",
    amount_minor: 21_399,
    original_amount_minor: 24_900,
    original_currency: "EUR",
    settlement_currency: "GBP",
    rate_scaled: 1_163_600,
    rate_scale: 6,
    rate_source: "read off the receipt",
    rate_date: "2026-06-14",
    category: "travel",
    spent_on: "2026-06-14",
    paid_by: "priya",
    splits: [
      { party_id: "me", share_minor: 5350 },
      { party_id: "priya", share_minor: 16_049 },
    ],
  };

  it("opens as EXACT amounts where the vault recorded no method", () => {
    const out = draftFromEntry(entry);
    expect(out.division).toBe("exact");
    expect(out.entries).toStrictEqual({ me: "53.50", priya: "160.49" });
  });

  it("re-opens the recorded method with the numbers that produced it", () => {
    const out = draftFromEntry({
      ...entry,
      split_method: "percentages",
      split_params: { unit: "percent", entries: { me: 25, priya: 75 } },
    });
    expect(out.division).toBe("percent");
    expect(out.entries).toStrictEqual({ me: "25", priya: "75" });
  });

  it("re-opens several payers, and leaves one payer alone", () => {
    const several = draftFromEntry({
      ...entry,
      payers: [
        { party_id: "priya", paid_minor: 16_049 },
        { party_id: "me", paid_minor: 5350 },
      ],
    });
    expect(several.payers).toStrictEqual({ priya: "160.49", me: "53.50" });
    const one = draftFromEntry({
      ...entry,
      payers: [{ party_id: "priya", paid_minor: 21_399 }],
    });
    expect(one.payers).toStrictEqual({});
  });

  it("brings the currency provenance back with it", () => {
    const out = draftFromEntry(entry);
    expect(out.foreign).toBe(true);
    expect(out.amount).toBe("249.00");
    expect(out.rate).toBe("1.1636");
    expect(out.rateSource).toBe("read off the receipt");
  });

  it("re-writes the same expense unchanged", () => {
    const out = draftFromEntry(entry);
    const verdict = expenseVerdict(out, ["me", "priya"], "GBP");
    expect(verdict.ok).toBe(true);
    expect(editExpenseInput(out, verdict, "GBP").amount_minor).toBe(21_399);
  });
});

describe("a settlement, which two other people may make", () => {
  const settle = (over = {}) => ({
    ...newSettleDraft({
      fromId: "ana",
      toId: "tom",
      groupId: null,
      today: "2026-08-26",
    }),
    amount: "25.00",
    ...over,
  });

  it("records a payment where the owner is NEITHER party", () => {
    const verdict = settleVerdict(settle(), "me");
    expect(verdict.ok).toBe(true);
    expect(verdict.yours).toBe(false);
  });

  it("knows when the owner is a party", () => {
    expect(settleVerdict(settle({ fromId: "me" }), "me").yours).toBe(true);
  });

  it("refuses a payment from someone to themselves, or with a party missing", () => {
    expect(settleVerdict(settle({ toId: "ana" }), "me").ok).toBe(false);
    expect(settleVerdict(settle({ toId: "" }), "me").ok).toBe(false);
  });

  it("refuses a payment of nothing", () => {
    expect(settleVerdict(settle({ amount: "0" }), "me").ok).toBe(false);
  });

  it("omits the group entirely when there is none — the command allows it", () => {
    const draftValue = settle();
    const input = settleInput(draftValue, settleVerdict(draftValue, "me"));
    expect(input).toStrictEqual({
      from_party: "ana",
      to_party: "tom",
      amount_minor: 2500,
      paid_on: "2026-08-26",
    });
  });

  it("scopes it to a group where one was chosen", () => {
    const draftValue = settle({ groupId: "flat" });
    expect(
      settleInput(draftValue, settleVerdict(draftValue, "me")).group_id
    ).toBe("flat");
  });
});
