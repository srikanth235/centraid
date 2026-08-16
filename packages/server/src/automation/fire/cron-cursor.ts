import type { AutomationTriggerCursor } from "@centraid/server/engine";

import { wallClockMinuteKey } from "../cron-timezone.js";
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
 * Pure virtual cron stream over `(from, to]`, ordered oldest-first. Matching
 * ANY schedule makes a minute due once: multiple cron triggers on one
 * automation are one schedule, not one stream each.
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
  const out: Date[] = [];
  const seen = new Set<string>();
  for (let instant = toMs; instant > earliest; instant -= 60_000) {
    const candidate = new Date(instant);
    const matching = schedules.filter((s) =>
      cronMatches(s.expr, candidate, s.timeZone)
    );
    if (matching.length === 0) continue;
    // A DST fall-back repeats a wall-clock minute in absolute time. Cron is a
    // wall-clock contract, so the repeat is the same due instant — counting it
    // twice would report a missed run the user never had. Key by each matching
    // schedule's zone wall clock so mixed-zone schedules still dedupe correctly.
    let novel = false;
    for (const s of matching) {
      const key = wallClockMinuteKey(candidate, s.timeZone);
      if (!seen.has(key)) {
        seen.add(key);
        novel = true;
      }
    }
    if (!novel) continue;
    out.push(candidate);
  }
  return out.toReversed();
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
  const due = dueInstants(exprsOrSchedules, new Date(from), new Date(to));
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
