// The timeline's month/day buckets and the two label lines beside them (v4
// handoff §4.3). Pure and DOM-free on purpose: the month header, the day
// sub-label, the scrub rail's tick table and the tests all read the SAME
// derivation, so a count in the header can never disagree with the tiles under
// it.
//
// COPY IS FINAL. `86 photographs · 4 videos` and `12 · Lyme Regis` are the
// handoff's strings; the only thing computed here is the numbers in them.
import { dayKey, fmtMonth, isVideoAsset } from "./format.ts";
import type { Asset } from "./types.ts";

/** One day inside a month — the tiles plus the sub-label's own line. */
export interface DayGroup {
  /** `YYYY-MM-DD`, local wall clock (format.ts `dayKey`). */
  key: string;
  assets: Asset[];
  /** `12 · Lyme Regis` — the count, and the place when every tile shares one. */
  meta: string;
}

/** One month — sticky header, its own count line, and its days. */
export interface MonthGroup {
  /** `YYYY-MM`. */
  key: string;
  /** `August 2026` — what the sticky header reads. */
  label: string;
  /** `86 photographs · 4 videos`. */
  count: string;
  days: DayGroup[];
  /** Every tile in the month, in order — what the counts are computed over. */
  assets: Asset[];
}

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The month header's count line. Videos are named separately because they are
 * a different thing to watch for, and the clause is dropped entirely when
 * there are none — a `· 0 videos` is noise about an absence.
 */
export function monthCount(assets: readonly Asset[]): string {
  const videos = assets.filter((asset) => isVideoAsset(asset)).length;
  const photographs = assets.length - videos;
  const head = plural(photographs, "photograph");
  return videos === 0 ? head : `${head} · ${plural(videos, "video")}`;
}

/**
 * The day sub-label's line: the count, then the place when — and only when —
 * every photograph in the day names the same one. A day that spans two places
 * has no single place to claim, and guessing one would be a lie about where
 * the member was.
 */
export function dayMeta(assets: readonly Asset[]): string {
  const count = String(assets.length);
  const names = new Set(
    assets.map((asset) => asset.place?.name).filter((n): n is string => !!n)
  );
  return names.size === 1 && assets.every((asset) => asset.place?.name)
    ? `${count} · ${[...names][0]}`
    : count;
}

/**
 * Bucket a newest-first list into months and days. The caller sorts; this
 * function preserves the order it is given so the trash shelf (sorted by
 * `deleted_at`) and the library (sorted by `taken_at`) can share it.
 */
export function groupByMonth(assets: readonly Asset[]): MonthGroup[] {
  const months = new Map<string, Map<string, Asset[]>>();
  for (const asset of assets) {
    const dk = dayKey(asset.taken_at);
    const mk = dk.slice(0, 7);
    let days = months.get(mk);
    if (!days) {
      days = new Map();
      months.set(mk, days);
    }
    const bucket = days.get(dk);
    if (bucket) bucket.push(asset);
    else days.set(dk, [asset]);
  }
  return [...months].map(([key, days]) => {
    const flat = [...days.values()].flat();
    return {
      key,
      label: fmtMonth(key),
      count: monthCount(flat),
      assets: flat,
      days: [...days].map(([dk, dayAssets]) => ({
        key: dk,
        assets: dayAssets,
        meta: dayMeta(dayAssets),
      })),
    };
  });
}

/**
 * The scrub rail's tick table (§4.5): one entry per month, newest first, with
 * the short label the rail prints every other month and the bubble prints on
 * the phone (`Aug 2026`).
 */
export interface MonthTick {
  key: string;
  /** `Aug 2026` — short, because 14px of column is not a place for prose. */
  short: string;
}

export function monthTicks(months: readonly MonthGroup[]): MonthTick[] {
  return months.map((month) => ({ key: month.key, short: shortMonth(month) }));
}

function shortMonth(month: MonthGroup): string {
  if (!month.key) return "Undated";
  try {
    return new Date(`${month.key}-01T00:00:00`).toLocaleDateString(undefined, {
      month: "short",
      year: "numeric",
    });
  } catch {
    return month.key;
  }
}
