import type { AutomationTriggerCursor } from "@centraid/server/engine";

import { wallClockFields, wallClockMinuteKey } from "../cron-timezone.js";
import { cronMatches } from "./cron-match.js";
import type { CursorReadResult } from "./cursor-engine.js";

/** One cron expression plus its resolved match zone (undefined = host-local). */
export type CronSchedule = {
  readonly expr: string;
  readonly timeZone?: string;
};

export function floorMinute(time: number): number {
  return Math.floor(time / 60_000) * 60_000;
}

/**
 * Hard bound on the minute-by-minute scan (31 days). A cursor restored from
 * an old backup would otherwise walk every minute since then — synchronously,
 * on the tick — only to keep the last match. The scan runs backwards so the
 * latest due instant is always found; past the horizon only the missed-run
 * COUNT degrades, and it degrades to a floor (never a phantom extra run).
 */
const MAX_SCAN_MINUTES = 44_640;

/**
 * How stale an idle cron window may get before the reader refreshes its
 * committed position. A quiet minute must not cost a journal write (a daily
 * automation would otherwise upsert 1,440 rows a day for nothing), but the
 * scan window must stay bounded, so an idle reader re-commits hourly.
 */
const IDLE_POSITION_REFRESH_MS = 60 * 60 * 1_000;

function asSchedules(
  exprsOrSchedules: readonly string[] | readonly CronSchedule[]
): CronSchedule[] {
  return exprsOrSchedules.map((entry) =>
    typeof entry === "string"
      ? { expr: entry }
      : { expr: entry.expr, timeZone: entry.timeZone }
  );
}

/**
 * How far back the reader looks for a wall-clock minute it has already
 * delivered. A fall-back repeats a wall clock exactly one DST shift later, and
 * no zone's shift has ever exceeded two hours, so three hours covers every
 * overlap with room to spare. The scan behind it runs ONLY when an overlap is
 * actually in play (see `fellBackWithin`), so an ordinary tick pays two
 * `Intl` reads for this, not 180 cron evaluations.
 */
const DST_OVERLAP_LOOKBACK_MS = 3 * 60 * 60 * 1_000;

/** Zone offset at `date`, to the minute. Undefined zone = host-local. */
function zoneOffsetMinutes(date: Date, timeZone?: string): number {
  const w = wallClockFields(date, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return Math.round((asUtc - floorMinute(date.getTime())) / 60_000);
}

/**
 * Did any schedule's zone move its clock BACK inside `(to - span, to]`? Only a
 * fall-back can repeat a wall-clock minute, and only then does the reader owe
 * anybody a cross-window memory.
 */
function fellBackWithin(
  schedules: readonly CronSchedule[],
  to: number,
  span: number
): boolean {
  return schedules.some(
    (s) =>
      zoneOffsetMinutes(new Date(to), s.timeZone) <
      zoneOffsetMinutes(new Date(to - span), s.timeZone)
  );
}

/** Every zone wall-clock key the schedules match on `candidate`. */
function wallClockKeysAt(
  schedules: readonly CronSchedule[],
  candidate: Date
): string[] {
  return schedules
    .filter((s) => cronMatches(s.expr, candidate, s.timeZone))
    .map((s) => wallClockMinuteKey(candidate, s.timeZone));
}

/**
 * Pure virtual cron stream over `(from, to]`, ordered oldest-first. Matching
 * ANY schedule makes a minute due once: multiple cron triggers on one
 * automation are one schedule, not one stream each.
 *
 * A DST fall-back repeats a wall-clock minute in absolute time. Cron is a
 * wall-clock contract, so the repeat is the SAME due instant — counting it
 * twice would report a missed run the user never had. Keys are per matching
 * schedule's zone so mixed-zone schedules dedupe correctly, and the dedupe
 * walks oldest-first so the survivor is the EARLIER instant, which is the
 * Overlap row's stated policy (docs/cron-timezone.md).
 */
export function dueInstants(
  exprsOrSchedules: readonly string[] | readonly CronSchedule[],
  from: Date,
  to: Date
): Date[] {
  const schedules = asSchedules(exprsOrSchedules);
  const toMs = floorMinute(to.getTime());
  const earliest = Math.max(
    floorMinute(from.getTime()),
    toMs - MAX_SCAN_MINUTES * 60_000
  );
  // Collected newest-first (the horizon above is a floor on how far back the
  // scan reaches, so the LATEST match must always be found), then reversed
  // before the dedupe so the earlier copy of a repeated wall minute wins.
  const matched: { at: Date; keys: string[] }[] = [];
  for (let instant = toMs; instant > earliest; instant -= 60_000) {
    const candidate = new Date(instant);
    const keys = wallClockKeysAt(schedules, candidate);
    if (keys.length > 0) matched.push({ at: candidate, keys });
  }
  matched.reverse();
  const out: Date[] = [];
  const seen = new Set<string>();
  for (const entry of matched) {
    let novel = false;
    for (const key of entry.keys) {
      if (!seen.has(key)) {
        seen.add(key);
        novel = true;
      }
    }
    if (novel) out.push(entry.at);
  }
  return out;
}

/**
 * The due instants in `(from, to]` that this reader still OWES the caller.
 *
 * `dueInstants` dedupes a repeated wall-clock minute perfectly, but only
 * against the window it was handed. A gateway that stays UP across a fall-back
 * ticks once a minute, so the two absolute minutes carrying the same wall clock
 * land in two different one-minute windows — each dedupes against itself and
 * fires, and the automation runs twice against the Overlap row's promise of
 * once (#846).
 *
 * The memory is derived, not persisted: when — and only when — a schedule's
 * zone actually moved its clock back inside the lookback, the reader re-walks
 * `(from - lookback, from]` and drops any candidate whose every wall-clock key
 * was already covered there. That keeps the cursor row a bare millisecond
 * position (no schema change, no watermark to migrate or corrupt), costs an
 * ordinary tick two `Intl` reads, and suppresses the LATER copy because the
 * earlier one is the instant the policy names.
 */
function deliverableInstants(
  schedules: readonly CronSchedule[],
  from: number,
  to: number
): Date[] {
  const due = dueInstants(schedules, new Date(from), new Date(to));
  if (due.length === 0) return due;
  if (!fellBackWithin(schedules, to, DST_OVERLAP_LOOKBACK_MS)) return due;
  const priorKeys = new Set<string>();
  for (
    let instant = floorMinute(from);
    instant > from - DST_OVERLAP_LOOKBACK_MS;
    instant -= 60_000
  ) {
    for (const key of wallClockKeysAt(schedules, new Date(instant)))
      priorKeys.add(key);
  }
  // Novel on at least one key, exactly as within a single window.
  return due.filter((candidate) =>
    wallClockKeysAt(schedules, candidate).some((key) => !priorKeys.has(key))
  );
}

/** Collapse a virtual cron window to its latest due instant and gap metadata. */
export function readCronCursor(
  exprsOrSchedules: readonly string[] | readonly CronSchedule[],
  cursor: AutomationTriggerCursor | undefined,
  at: Date
): CursorReadResult {
  const to = floorMinute(at.getTime());
  let parsed = to - 60_000;
  if (cursor?.positionJson) {
    try {
      parsed = Number(JSON.parse(cursor.positionJson));
    } catch {
      parsed = Number.NaN;
    }
  }
  const from = Number.isFinite(parsed) ? parsed : to - 60_000;
  const due = deliverableInstants(asSchedules(exprsOrSchedules), from, to);
  const latest = due.at(-1);
  if (!latest) {
    // Nothing was due. The whole window was enumerated, so advancing is
    // lossless — but it is also pointless work, so the position is committed
    // only to record the first (bootstrap) window, then refreshed once the
    // idle window grows past the horizon.
    const bootstrap = cursor?.positionJson === undefined;
    return {
      elements: [],
      skipped: 0,
      ...(bootstrap || to - from >= IDLE_POSITION_REFRESH_MS
        ? { positionJson: JSON.stringify(to) }
        : {}),
    };
  }
  return {
    elements: [
      { position: String(latest.getTime()), occurredAt: latest.getTime() },
    ],
    positionJson: JSON.stringify(to),
    windowFrom: from,
    windowTo: to,
    skipped: Math.max(0, due.length - 1),
    ...(due.length > 1 ? { gapReason: "scheduler_gap" } : {}),
  };
}
