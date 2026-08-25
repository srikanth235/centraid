import type { AutomationTriggerCursor } from "@centraid/server/engine";

import { wallClockFields, wallClockMinuteKey } from "../cron-timezone.js";
import { cronMatches } from "./cron-match.js";
import type { CursorReadResult } from "./cursor-engine.js";

export type CronSchedule = {
  readonly expr: string;
  readonly timeZone?: string;
};

export function floorMinute(time: number): number {
  return Math.floor(time / 60_000) * 60_000;
}

/** Bounds a synchronous scan from an old cursor; past it only the missed-run
 *  COUNT degrades, to a floor. */
const MAX_SCAN_MINUTES = 44_640;

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

/** No DST shift has exceeded two hours, so three covers every overlap. */
const DST_OVERLAP_LOOKBACK_MS = 3 * 60 * 60 * 1_000;

function zoneOffsetMinutes(date: Date, timeZone?: string): number {
  const w = wallClockFields(date, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return Math.round((asUtc - floorMinute(date.getTime())) / 60_000);
}

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

function wallClockKeysAt(
  schedules: readonly CronSchedule[],
  candidate: Date
): string[] {
  return schedules
    .filter((s) => cronMatches(s.expr, candidate, s.timeZone))
    .map((s) => wallClockMinuteKey(candidate, s.timeZone));
}

/** Matching ANY schedule makes a minute due ONCE. Cron is a wall-clock
 *  contract, so a fall-back's repeat is the same instant and the EARLIER copy
 *  survives (docs/cron-timezone.md). */
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

/** `dueInstants` dedupes only within its own window, so a gateway up across a
 *  fall-back would fire one wall minute twice (#846). The memory is DERIVED,
 *  never persisted — the cursor row stays a bare millisecond position. */
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
  return due.filter((candidate) =>
    wallClockKeysAt(schedules, candidate).some((key) => !priorKeys.has(key))
  );
}

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
