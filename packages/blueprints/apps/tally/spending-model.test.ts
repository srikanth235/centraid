import { describe, expect, it } from "vitest";

import {
  CATEGORIES,
  CATEGORY_ROWS,
  categoryTotals,
  inMonth,
  monthTotal,
  paidVersusShare,
} from "./spending-model.ts";
import type { ActivityRow } from "./types.ts";

const NOW = "2026-07-18T09:00:00.000Z";

function expense(patch: Partial<ActivityRow>): ActivityRow {
  return {
    kind: "expense",
    date: "2026-07-04",
    category: "general",
    amount_minor: 1000,
    your_role: "none",
    your_amount_minor: 0,
    ...patch,
  };
}

describe("the closed nine", () => {
  it("names exactly the nine the vault stores", () => {
    expect(CATEGORIES).toHaveLength(9);
    expect(CATEGORIES.map(([key]) => key)).toStrictEqual([
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

describe("what the month went on", () => {
  it("sums the whole expense per category, largest first", () => {
    const rows = [
      expense({ category: "rent", amount_minor: 145_000 }),
      expense({ category: "food", amount_minor: 8420 }),
      expense({ category: "food", amount_minor: 4200 }),
    ];
    expect(categoryTotals(rows, NOW)).toStrictEqual([
      { key: "rent", label: "Rent", total_minor: 145_000 },
      { key: "food", label: "Food", total_minor: 12_620 },
    ]);
  });

  it("never counts a settlement as spending", () => {
    const rows: ActivityRow[] = [
      expense({ category: "travel", amount_minor: 9600 }),
      { kind: "settlement", date: "2026-07-05", amount_minor: 6400 },
    ];
    expect(categoryTotals(rows, NOW)).toStrictEqual([
      { key: "travel", label: "Travel", total_minor: 9600 },
    ]);
    expect(monthTotal(rows, NOW)).toBe(9600);
  });

  it("keeps last month out of this month", () => {
    const rows = [
      expense({ date: "2026-06-30", category: "fun", amount_minor: 6000 }),
      expense({ date: "2026-07-01", category: "fun", amount_minor: 1500 }),
    ];
    expect(inMonth("2026-06-30", NOW)).toBe(false);
    expect(categoryTotals(rows, NOW)).toStrictEqual([
      { key: "fun", label: "Fun", total_minor: 1500 },
    ]);
  });

  it("files an expense with no category under General rather than dropping it", () => {
    const rows = [expense({ category: undefined, amount_minor: 500 })];
    expect(categoryTotals(rows, NOW)[0]?.key).toBe("general");
  });

  it("shows six rows, because the seventh is the one nobody reads", () => {
    const rows = CATEGORIES.map(([key], index) =>
      expense({ category: key, amount_minor: (9 - index) * 100 })
    );
    expect(categoryTotals(rows, NOW)).toHaveLength(CATEGORY_ROWS);
    expect(monthTotal(rows, NOW)).toBe(4500);
  });
});

describe("paid, and owed", () => {
  it("counts the whole expense as paid and only the split as yours", () => {
    const rows = [
      expense({
        amount_minor: 10_000,
        your_role: "lent",
        your_amount_minor: 6666,
      }),
    ];
    expect(paidVersusShare(rows, NOW)).toStrictEqual({
      paid_minor: 10_000,
      share_minor: 3334,
      difference_minor: 6666,
    });
  });

  it("counts a borrowed share as yours and nothing as paid", () => {
    const rows = [
      expense({
        amount_minor: 8420,
        your_role: "borrowed",
        your_amount_minor: 2807,
      }),
    ];
    expect(paidVersusShare(rows, NOW)).toStrictEqual({
      paid_minor: 0,
      share_minor: 2807,
      difference_minor: -2807,
    });
  });

  it("leaves an expense the owner is not in out of both figures", () => {
    const rows = [expense({ amount_minor: 5000, your_role: "none" })];
    expect(paidVersusShare(rows, NOW)).toStrictEqual({
      paid_minor: 0,
      share_minor: 0,
      difference_minor: 0,
    });
  });

  it("reads the pair over a mixed month", () => {
    const rows = [
      expense({
        amount_minor: 10_000,
        your_role: "lent",
        your_amount_minor: 6666,
      }),
      expense({
        amount_minor: 8420,
        your_role: "borrowed",
        your_amount_minor: 2807,
      }),
      { kind: "settlement", date: "2026-07-09", amount_minor: 4000 } as const,
    ];
    expect(paidVersusShare(rows, NOW)).toStrictEqual({
      paid_minor: 10_000,
      share_minor: 6141,
      difference_minor: 3859,
    });
  });
});
