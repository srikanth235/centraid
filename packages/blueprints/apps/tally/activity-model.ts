import { DAY_MS } from "../_shared/format-kit.ts";
import type { ActivityRow, LedgerEntry } from "./types.ts";

export const ACTIVITY_WINDOW = 60;

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

function previousDay(dayKey: string): string {
  const stamp = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(stamp)) return "";
  return new Date(stamp - DAY_MS).toISOString().slice(0, 10);
}

export function bucketOf(
  date: string | undefined,
  nowIso: string
): DayBucketKey {
  const day = String(date ?? "").slice(0, 10);
  const today = nowIso.slice(0, 10);
  if (day === today) return "today";
  return day === previousDay(today) ? "yesterday" : "earlier";
}

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
  more: boolean;
}

export function windowOf<T>(rows: readonly T[], size: number): WindowState<T> {
  const shown = Math.max(0, Math.min(size, rows.length));
  return {
    rows: rows.slice(0, shown),
    shown,
    total: rows.length,
    more: shown < rows.length,
  };
}

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
