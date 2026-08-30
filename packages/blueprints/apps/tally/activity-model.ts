import { DAY_MS } from "../_shared/format-kit.ts";
// Activity's two folds: which day a row belongs to, and where the window ends.
//
// NEITHER TOUCHES A FIGURE. The feed arrives interleaved and newest-first from
// `queries/activity.ts`, already carrying each row's amount and the owner's
// stance on it; this module only decides which heading a row sits under and
// how much of the feed is on screen. A bounded window that reads as everything
// is the defect the end row exists to close.
import type { ActivityRow, LedgerEntry } from "./types.ts";

/** How many rows the feed shows before it says so. */
export const ACTIVITY_WINDOW = 60;

/** How much further "Show more" opens the window each time. */
export const ACTIVITY_STEP = 60;

export type DayBucketKey = "today" | "yesterday" | "earlier";

export interface DayBucket {
  key: DayBucketKey;
  label: string;
  rows: ActivityRow[];
}

const BUCKET_LABEL: Readonly<Record<DayBucketKey, string>> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

/** The day key one day before the given one, arithmetic done in UTC on the
 *  key itself — the vault stores day keys, and a local-midnight round trip
 *  would move a row across a heading for members east of the meridian. */
function previousDay(dayKey: string): string {
  const stamp = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(stamp)) return "";
  return new Date(stamp - DAY_MS).toISOString().slice(0, 10);
}

/** Which heading a dated row sits under. A row with no date at all is
 *  `earlier`: it is not today, and claiming it were would be an invention. */
export function bucketOf(
  date: string | undefined,
  nowIso: string
): DayBucketKey {
  const day = String(date ?? "").slice(0, 10);
  const today = nowIso.slice(0, 10);
  if (day === today) return "today";
  return day === previousDay(today) ? "yesterday" : "earlier";
}

/**
 * The feed under its three headings, in feed order. A heading with nothing
 * under it is ABSENT rather than drawn empty — an empty "Yesterday" is a claim
 * about a day nobody asked about.
 */
export function dayBuckets(
  rows: readonly ActivityRow[],
  nowIso: string
): DayBucket[] {
  const buckets = new Map<DayBucketKey, ActivityRow[]>();
  for (const row of rows) {
    const key = bucketOf(row.date, nowIso);
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }
  return (["today", "yesterday", "earlier"] as const)
    .filter((key) => (buckets.get(key)?.length ?? 0) > 0)
    .map((key) => ({
      key,
      label: BUCKET_LABEL[key],
      rows: buckets.get(key) ?? [],
    }));
}

export interface WindowState<T> {
  rows: T[];
  shown: number;
  total: number;
  /** Is there more behind this window? The end row is drawn either way — a
   *  window that happens to hold everything still says how much that is. */
  more: boolean;
}

/** The window over any bounded list, with the two counts the end row states. */
export function windowOf<T>(rows: readonly T[], size: number): WindowState<T> {
  const shown = Math.max(0, Math.min(size, rows.length));
  return {
    rows: rows.slice(0, shown),
    shown,
    total: rows.length,
    more: shown < rows.length,
  };
}

/** Whether any row in a ledger involves this party at all — the removal
 *  guard's one question. A member who appears on the ledger cannot be removed
 *  without making its arithmetic unreadable; they are marked departed instead.
 *  This is a PARTICIPATION test, not a balance: it reads ids and nothing else. */
export function appearsOnLedger(
  ledger: readonly LedgerEntry[],
  partyId: string
): boolean {
  return ledger.some(
    (entry) =>
      entry.paid_by === partyId ||
      entry.splits.some((split) => split.party_id === partyId)
  );
}
