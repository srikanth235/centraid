// The runs chart's arithmetic (#765). Two claims a renderer cannot make for
// itself: segments STACK rather than overlap, so the pair never exceeds the
// plot, and a longer series is TAILED, never sampled. Both hold on DOM and
// React Native, so this module stops at the numbers.

export interface BarSegments {
  ok: number;
  fail: number;
}

export interface BarStack extends BarSegments {
  /** A zero-height segment and no segment differ: the first spends a colour. */
  hasFail: boolean;
}

function clamp(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, ceiling);
}

/** Clamp FAIL first, `ok` takes what is left: if both cannot fit, the truncated
 *  one must be the good news. */
export function barStack(segments: BarSegments): BarStack {
  const fail = clamp(segments.fail, 100);
  return { fail, hasFail: fail > 0, ok: clamp(segments.ok, 100 - fail) };
}

export function barWindow<T>(
  series: readonly T[],
  count: number
): readonly T[] {
  return series.slice(Math.max(0, series.length - count));
}

// THE DAY FOLD. Days with no activity are ABSENT from the rollup, so fold by
// CALENDAR OFFSET from the window's first day, never by array position: a quiet
// week would otherwise slide busy days left and claim work on empty days.

const DAY_MS = 86_400_000;

export interface DaySeriesPoint {
  date: string;
  runs: number;
  costUsd: number;
}

export interface DayFoldOptions {
  windowDays: number;
  /** The ROLLUP's clock, never the reader's: an hour later it must still say
   *  the same thing. */
  anchor: number;
  /** `windowDays` is the honest value; fewer, and each bucket must state the
   *  span it covers. */
  columns: number;
}

export interface DayBucket {
  key: string;
  fromDay: number;
  toDay: number;
  date: string;
  endDate: string;
  runs: number;
  costUsd: number;
}

function dayKey(epochDay: number): string {
  return new Date(epochDay * DAY_MS).toISOString().slice(0, 10);
}

export function dayFold(
  points: readonly DaySeriesPoint[],
  options: DayFoldOptions
): readonly DayBucket[] {
  const windowDays = Math.max(1, Math.floor(options.windowDays));
  const count = Math.min(
    windowDays,
    Math.max(1, Math.floor(options.columns) || 1)
  );
  const anchorMs = Number.isFinite(options.anchor)
    ? options.anchor
    : Date.now();
  const firstDay = Math.floor(anchorMs / DAY_MS) - (windowDays - 1);
  const buckets: DayBucket[] = Array.from({ length: count }, (_unused, i) => {
    const fromDay = Math.round((i * windowDays) / count);
    const toDay = Math.round(((i + 1) * windowDays) / count) - 1;
    return {
      costUsd: 0,
      date: dayKey(firstDay + fromDay),
      endDate: dayKey(firstDay + toDay),
      fromDay,
      key: `col-${i}`,
      runs: 0,
      toDay,
    };
  });
  for (const point of points) {
    const ms = Date.parse(`${point.date}T00:00:00Z`);
    if (Number.isNaN(ms)) continue;
    const offset = Math.floor(ms / DAY_MS) - firstDay;
    if (offset < 0 || offset >= windowDays) continue;
    const bucket = buckets[Math.floor((offset * count) / windowDays)];
    if (!bucket) continue;
    bucket.runs += point.runs;
    bucket.costUsd += point.costUsd;
  }
  return buckets;
}

/** A column that measured SOMETHING is never drawn as nothing: it gets the
 *  one-percent floor. */
export function barShares(values: readonly number[]): number[] {
  const clean = values.map((value) =>
    Number.isFinite(value) && value > 0 ? value : 0
  );
  const peak = Math.max(0, ...clean);
  if (peak <= 0) return clean.map(() => 0);
  return clean.map((value) =>
    value > 0 ? Math.max(1, Math.round((value / peak) * 100)) : 0
  );
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** `2026-07-15` → `15 Jul`. The month is NAMED, never numbered: `07/15` and
 *  `15/07` read two ways. Not localized — the day is a UTC key. */
export function dayMark(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return "";
  const at = new Date(ms);
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()] ?? ""}`.trim();
}
