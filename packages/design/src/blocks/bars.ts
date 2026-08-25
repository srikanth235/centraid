// The runs chart's arithmetic (#765, spec §9) — the whole of it.
//
// The chart draws TWO outcomes stacked in one column, and the only two claims
// it makes that a renderer cannot make for itself are here: the segments stack
// rather than overlap (so the pair can never exceed the plot), and a series
// longer than the chart is TAILED rather than sampled. Both are the same on
// DOM and on React Native; only the units differ (a CSS custom property takes
// the number, a native style takes a `%` string), so this module stops at the
// numbers.

/** One column's two measured shares of the plot height, 0–100. */
export interface BarSegments {
  /** Runs that succeeded. */
  ok: number;
  /** Runs that failed. Stacked ON TOP of `ok`. */
  fail: number;
}

/** The same two shares, made safe to draw. */
export interface BarStack extends BarSegments {
  /** Whether a failed segment is drawn at all. A zero-height segment and no
   *  segment are different things: the first still spends the one colour. */
  hasFail: boolean;
}

function clamp(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, ceiling);
}

/**
 * Stack one column's segments.
 *
 * The failed share is clamped FIRST and the succeeded share takes what is
 * left, because failure is the fact the chart exists to show: if the two
 * cannot both fit, the one that gets truncated is the good news.
 */
export function barStack(segments: BarSegments): BarStack {
  const fail = clamp(segments.fail, 100);
  return { fail, hasFail: fail > 0, ok: clamp(segments.ok, 100 - fail) };
}

/**
 * The columns actually drawn, when the chart has a fixed count.
 *
 * A longer series is tailed to its most recent columns; a shorter one is drawn
 * as it is rather than padded, because empty days at the head of a chart read
 * as outages. A surface that draws every column it is given does not call this.
 */
export function barWindow<T>(
  series: readonly T[],
  count: number
): readonly T[] {
  return series.slice(Math.max(0, series.length - count));
}

// ───────────────────────────────────────────────────────────────────────────
// The day fold
// ───────────────────────────────────────────────────────────────────────────
//
// The daily rollup is folded into columns HERE, once, for both kits: days
// with NO activity are absent from the rollup (it groups by day), so the fold
// is by CALENDAR OFFSET from the window's first day and never by position in
// the array — otherwise a quiet week slides the busy days left and the chart
// claims work happened on days nothing ran.

const DAY_MS = 86_400_000;

/** One day of a rollup, as the gateway groups it. */
export interface DaySeriesPoint {
  /** `YYYY-MM-DD` — the rollup's own UTC day key. */
  date: string;
  runs: number;
  costUsd: number;
}

export interface DayFoldOptions {
  /** Days the window covers, ending on the anchor's day. */
  windowDays: number;
  /** The ROLLUP's clock (epoch ms), never the reader's: a summary read an hour
   *  later must still say the same thing about the same days. */
  anchor: number;
  /**
   * Columns the surface can legibly draw.
   *
   * `windowDays` — one column per day — is the honest value and the only one
   * where a single busy day is still its own column. A surface that genuinely
   * cannot fit that many (ninety bars on a 390pt phone) asks for fewer, and
   * every bucket then states the span it covers rather than a single date.
   */
  columns: number;
}

/** One column of the fold: what it covers, and what happened inside it. */
export interface DayBucket {
  /** Stable identity for a keyed list. */
  key: string;
  /** Offsets from the window's first day, inclusive, oldest first. */
  fromDay: number;
  toDay: number;
  /** The bucket's FIRST calendar day, `YYYY-MM-DD`. */
  date: string;
  /** The bucket's last calendar day. Equal to `date` at one column per day. */
  endDate: string;
  runs: number;
  costUsd: number;
}

function dayKey(epochDay: number): string {
  return new Date(epochDay * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Fold a daily rollup into the columns a chart will draw.
 *
 * Buckets are contiguous and cover the whole window, so a bucket with no runs
 * is a measured quiet day rather than a missing one.
 */
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

/**
 * Scale a series against its own peak, as shares of the plot height.
 *
 * A column that measured SOMETHING is never drawn as nothing: a day whose
 * spend rounds below one percent of the peak still gets the one-percent floor,
 * because a chart that draws a $0.004 day and a $0 day identically has hidden
 * the difference it exists to show.
 */
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

/**
 * A rollup day key as an axis mark — `2026-07-15` → `15 Jul`.
 *
 * Both kits mark the same axis, so the words are decided once. The month is
 * named rather than numbered because `07/15` and `15/07` are the same six
 * characters read two ways, and the axis has no room to disambiguate. Not
 * localized: `Intl` would make the mark depend on the reader's locale data
 * while the DAY it marks is a UTC key the gateway chose.
 */
export function dayMark(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return "";
  const at = new Date(ms);
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()] ?? ""}`.trim();
}
