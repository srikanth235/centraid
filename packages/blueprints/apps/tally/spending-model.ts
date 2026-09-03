import type { ActivityRow, Role } from "./types.ts";

export const CATEGORIES: readonly (readonly [string, string])[] = [
  ["food", "Food"],
  ["groceries", "Groceries"],
  ["rent", "Rent"],
  ["utilities", "Utilities"],
  ["transport", "Transport"],
  ["fun", "Fun"],
  ["travel", "Travel"],
  ["shopping", "Shopping"],
  ["general", "General"],
];

const CATEGORY_LABEL = new Map(CATEGORIES);

export const CATEGORY_ROWS = 6;

export interface CategoryTotal {
  key: string;
  label: string;
  total_minor: number;
}

export function inMonth(day: string | undefined, nowIso: string): boolean {
  return String(day ?? "").slice(0, 7) === nowIso.slice(0, 7);
}

export function categoryTotals(
  rows: readonly ActivityRow[],
  nowIso: string,
  take: number = CATEGORY_ROWS
): CategoryTotal[] {
  const sums = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "expense") continue;
    if (!inMonth(row.date, nowIso)) continue;
    const key = row.category ?? "general";
    sums.set(key, (sums.get(key) ?? 0) + Number(row.amount_minor ?? 0));
  }
  return [...sums.entries()]
    .map(([key, total_minor]) => ({
      key,
      label: CATEGORY_LABEL.get(key) ?? key,
      total_minor,
    }))
    .sort((left, right) => right.total_minor - left.total_minor)
    .slice(0, take);
}

export function monthTotal(
  rows: readonly ActivityRow[],
  nowIso: string
): number {
  let total = 0;
  for (const row of rows) {
    if (row.kind !== "expense") continue;
    if (!inMonth(row.date, nowIso)) continue;
    total += Number(row.amount_minor ?? 0);
  }
  return total;
}

export interface PaidVersusShare {
  paid_minor: number;
  share_minor: number;
  difference_minor: number;
}

function ownShare(row: ActivityRow): number {
  const role: Role = row.your_role ?? "none";
  const mine = Number(row.your_amount_minor ?? 0);
  if (role === "lent") return Number(row.amount_minor ?? 0) - mine;
  return role === "borrowed" ? mine : 0;
}

export function paidVersusShare(
  rows: readonly ActivityRow[],
  nowIso: string
): PaidVersusShare {
  let paid = 0;
  let share = 0;
  for (const row of rows) {
    if (row.kind !== "expense") continue;
    if (!inMonth(row.date, nowIso)) continue;
    if (row.your_role === "lent") paid += Number(row.amount_minor ?? 0);
    share += ownShare(row);
  }
  return {
    paid_minor: paid,
    share_minor: share,
    difference_minor: paid - share,
  };
}
