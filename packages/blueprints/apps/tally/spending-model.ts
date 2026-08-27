// Spending's two folds — the only arithmetic the INTERFACE does, and neither
// of them is a balance.
//
// WHY THIS IS NOT A SECOND BALANCE ENGINE. A balance answers *who owes whom*
// and is derived once, on the query side, from expenses, settlements and
// People's obligations (`queries/dashboard.ts`). Spending answers two much
// smaller questions over rows the queries already decorated: *what did the
// month go on*, and *what did you front versus what is actually yours*. The
// difference between those two figures is carried in balances — it is not a
// saving, and this module never presents it as one.
//
// RESTRAINT IS THE DESIGN (gap register §6). Six category rows and the
// paid-versus-share pair. No trend, no chart beyond a proportion bar, no
// second level of category: the nine are closed, and they exist to make this
// screen legible rather than to describe a purchase.
import type { ActivityRow, Role } from "./types.ts";

/** The closed nine, in the vault's own order. A tenth is a schema change, not
 *  a preference, and nothing in the interface implies otherwise. */
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

/** How many category rows the screen draws. Six, because the seventh is the
 *  row nobody reads and the tail is what the total already says. */
export const CATEGORY_ROWS = 6;

export interface CategoryTotal {
  key: string;
  label: string;
  total_minor: number;
}

/** Is this day inside the month `nowIso` falls in? Compared on the day key
 *  the vault stores, so a member's month never straddles a time zone. */
export function inMonth(day: string | undefined, nowIso: string): boolean {
  return String(day ?? "").slice(0, 7) === nowIso.slice(0, 7);
}

/**
 * What the month went on, largest first. Every row is a SUM OF EXPENSE
 * AMOUNTS — the whole expense, not the owner's share, because the question is
 * what the ledger spent. Settlements are not spending: a settlement moves an
 * existing debt and adds nothing to any category, so the feed's settlement
 * rows are dropped rather than counted as `general`.
 */
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
    .toSorted((left, right) => right.total_minor - left.total_minor)
    .slice(0, take);
}

/** Everything the month's categories add up to — stated beside the rows, so a
 *  member can see what the six leave out. */
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
  /** What left the owner's account — the expenses they fronted, in full. */
  paid_minor: number;
  /** What the splits make theirs, across every expense they are in. */
  share_minor: number;
  /** The gap between the two. Carried in balances, and never a saving. */
  difference_minor: number;
}

/** The owner's share of one decorated row, read back out of the stance the
 *  query already put on it. `lent` carries what the OTHERS owe, so the
 *  owner's own share is the remainder. */
function ownShare(row: ActivityRow): number {
  const role: Role = row.your_role ?? "none";
  const mine = Number(row.your_amount_minor ?? 0);
  if (role === "lent") return Number(row.amount_minor ?? 0) - mine;
  return role === "borrowed" ? mine : 0;
}

/**
 * The two figures a splitting tool keeps apart: what you paid, and what is
 * yours. Folded over the same decorated feed the Activity list reads, so the
 * pair can never disagree with the rows above it.
 */
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
