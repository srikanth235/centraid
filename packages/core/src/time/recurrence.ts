import {
  addWallDays,
  addWallMonths,
  parseWallIso,
  resolveWallTime,
  wallEpoch,
  wallIso,
  wallWeekday,
  zonedParts,
} from "./timezone.js";
import type { WallTime } from "./timezone.js";

const DAY_TOKENS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
type DayToken = (typeof DAY_TOKENS)[number];

export type RecurrenceSemantics = "zoned" | "floating" | "all-day";

export interface ParsedRrule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: string;
  byDay?: DayToken[];
}

export interface ExpandRecurrenceInput {
  rrule: string;
  start: string;
  rangeFrom: string;
  rangeTo: string;
  timeZone?: string;
  semantics?: RecurrenceSemantics;
  maxInstances?: number;
}

export interface RecurrenceInstance {
  originalStart: string;
  start: string;
  wallStart: string;
  overlap: boolean;
}

export interface RecurrenceException {
  originalStart: string;
  action: "skip" | "override";
  scope?: "occurrence" | "future";
  start?: string;
}

export interface NextOccurrenceInput {
  rrule: string;
  scheduledStart: string;
  after: string;
  timeZone?: string;
  anchor?: "scheduled" | "completion";
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Math.trunc(Number(value));
  // COUNT=0 is invalid ICS (and previously clamped to 1). Treat non-positive
  // bounds as a single occurrence rather than unbounded expansion.
  if (!Number.isFinite(parsed)) return undefined;
  return parsed > 0 ? parsed : 1;
}

/**
 * Canonical bare RRULE body (`FREQ=…`). Strips a leading `RRULE:` (Google
 * Calendar and ICS both emit the prefixed form) and collapses whitespace so
 * schedule preconditions, parseRrule, and ICS export share one shape.
 */
export function canonicalizeRrule(value: string): string {
  return value
    .replace(/^\s*RRULE:/iu, "")
    .replace(/\s+/gu, "")
    .trim();
}

/** Prefixed RRULE line for Google/ICS writeback without double-prefixing. */
export function rruleLine(value: string): string {
  const bare = canonicalizeRrule(value);
  return bare ? `RRULE:${bare}` : "";
}

export function parseRrule(value: string): ParsedRrule | null {
  const parts = new Map<string, string>();
  for (const segment of canonicalizeRrule(value).split(";")) {
    const equals = segment.indexOf("=");
    if (equals < 0) continue;
    parts.set(
      segment.slice(0, equals).trim().toUpperCase(),
      segment
        .slice(equals + 1)
        .trim()
        .toUpperCase()
    );
  }
  const freq = parts.get("FREQ");
  if (
    freq !== "DAILY" &&
    freq !== "WEEKLY" &&
    freq !== "MONTHLY" &&
    freq !== "YEARLY"
  ) {
    return null;
  }
  const interval = positiveInteger(parts.get("INTERVAL")) ?? 1;
  const count = positiveInteger(parts.get("COUNT"));
  const until = parts.get("UNTIL");
  const byDay = parts
    .get("BYDAY")
    ?.split(",")
    .map((day) => day.trim())
    .filter((day): day is DayToken =>
      (DAY_TOKENS as readonly string[]).includes(day)
    );
  return {
    freq,
    interval,
    ...(count === undefined ? {} : { count }),
    ...(until === undefined ? {} : { until }),
    ...(byDay === undefined || byDay.length === 0 ? {} : { byDay }),
  };
}

function parseBasicInstant(value: string): number | null {
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return direct;
  const match =
    /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})(?:T(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2}))?Z?$/u.exec(
      value
    );
  if (!match?.groups) return null;
  return Date.UTC(
    Number(match.groups.year),
    Number(match.groups.month) - 1,
    Number(match.groups.day),
    Number(match.groups.hour ?? 0),
    Number(match.groups.minute ?? 0),
    Number(match.groups.second ?? 0)
  );
}

function startWall(
  start: string,
  semantics: RecurrenceSemantics,
  timeZone: string | undefined
): WallTime | null {
  if (semantics === "zoned") {
    const instant = Date.parse(start);
    if (Number.isNaN(instant) || timeZone === undefined) return null;
    return zonedParts(instant, timeZone);
  }
  return parseWallIso(start);
}

function stepAnchor(
  initial: WallTime,
  rule: ParsedRrule,
  index: number
): WallTime {
  switch (rule.freq) {
    case "DAILY":
      return addWallDays(initial, index * rule.interval);
    case "WEEKLY":
      return addWallDays(initial, index * 7 * rule.interval);
    case "MONTHLY":
      return addWallMonths(initial, index * rule.interval);
    case "YEARLY":
      return addWallMonths(initial, index * 12 * rule.interval);
  }
}

function weeklyCandidates(
  initial: WallTime,
  rule: ParsedRrule,
  weekIndex: number
): WallTime[] {
  const anchor = addWallDays(
    initial,
    weekIndex * 7 * rule.interval - wallWeekday(initial)
  );
  return (rule.byDay ?? [])
    .map((day) => addWallDays(anchor, DAY_TOKENS.indexOf(day)))
    .sort((left, right) => wallEpoch(left) - wallEpoch(right));
}

function resolveCandidate(
  wall: WallTime,
  semantics: RecurrenceSemantics,
  timeZone: string | undefined
): RecurrenceInstance | null {
  const wallStart = wallIso(wall, semantics !== "all-day");
  if (semantics === "zoned") {
    if (timeZone === undefined) return null;
    const resolved = resolveWallTime(wall, timeZone);
    if (!resolved) return null;
    return {
      originalStart: resolved.instant,
      start: resolved.instant,
      wallStart,
      overlap: resolved.overlap,
    };
  }
  return {
    originalStart: wallStart,
    start: wallStart,
    wallStart,
    overlap: false,
  };
}

function instantForComparison(
  value: string,
  semantics: RecurrenceSemantics
): number {
  if (semantics === "zoned") return Date.parse(value);
  const wall = parseWallIso(value);
  return wall ? wallEpoch(wall) : Number.NaN;
}

function withinUntil(
  instance: RecurrenceInstance,
  until: string | undefined,
  semantics: RecurrenceSemantics
): boolean {
  if (until === undefined) return true;
  const untilMs = parseBasicInstant(until);
  if (untilMs === null) return true;
  return instantForComparison(instance.start, semantics) <= untilMs;
}

/**
 * Expand a recurrence using civil-time arithmetic. Zoned rules preserve their
 * wall clock through offset changes, skip DST gaps, and emit overlaps once at
 * the earlier instant.
 */
export function expandRecurrence(
  input: ExpandRecurrenceInput
): RecurrenceInstance[] {
  const rule = parseRrule(input.rrule);
  const semantics = input.semantics ?? "zoned";
  const initial = startWall(input.start, semantics, input.timeZone);
  const from = instantForComparison(input.rangeFrom, semantics);
  const to = instantForComparison(input.rangeTo, semantics);
  if (
    !rule ||
    !initial ||
    Number.isNaN(from) ||
    Number.isNaN(to) ||
    from >= to
  ) {
    return [];
  }

  const limit = Math.max(1, Math.min(input.maxInstances ?? 366, 10_000));
  const results: RecurrenceInstance[] = [];
  // Fast-forward analytically to the first period that can intersect
  // rangeFrom — but only for unbounded rules. A COUNT series must walk from
  // the anchor so exhaustion is observed after a few periods (COUNT=1 on a
  // 2000 anchor must not convert twenty-six years of civil time). Unbounded
  // monthly/daily templates still need the jump so maxInstances:2 can land
  // a 2026 occurrence of a 2022 series.
  let period =
    rule.count === undefined
      ? firstPeriodAtOrAfter(initial, rule, from, semantics)
      : 0;
  let emitted = 0;
  let guard = 0;
  while (results.length < limit && guard < limit * 16) {
    guard += 1;
    const walls =
      rule.freq === "WEEKLY" && rule.byDay
        ? weeklyCandidates(initial, rule, period)
        : [stepAnchor(initial, rule, period)];
    for (const wall of walls) {
      if (wallEpoch(wall) < wallEpoch(initial)) continue;
      const instance = resolveCandidate(wall, semantics, input.timeZone);
      if (!instance) continue;
      if (!withinUntil(instance, rule.until, semantics)) return results;
      if (rule.count !== undefined && emitted >= rule.count) return results;
      emitted += 1;
      const value = instantForComparison(instance.start, semantics);
      if (value >= to) return results;
      if (value >= from) results.push(instance);
      if (results.length >= limit) return results;
    }
    period += 1;
  }
  return results;
}

/**
 * Smallest period index whose candidates can land on or after `fromMs`.
 * Overshoots by at most one interval so the subsequent walk still applies
 * BYDAY / UNTIL / COUNT filters exactly.
 */
function firstPeriodAtOrAfter(
  initial: WallTime,
  rule: ParsedRrule,
  fromMs: number,
  semantics: RecurrenceSemantics
): number {
  const anchorMs = wallEpoch(initial);
  if (fromMs <= anchorMs) return 0;
  const deltaMs = fromMs - anchorMs;
  switch (rule.freq) {
    case "DAILY":
      return Math.max(
        0,
        Math.floor(deltaMs / (86_400_000 * rule.interval)) - 1
      );
    case "WEEKLY":
      return Math.max(
        0,
        Math.floor(deltaMs / (7 * 86_400_000 * rule.interval)) - 1
      );
    case "MONTHLY": {
      // Approximate months from civil fields, then back up one interval.
      const fromWall = wallFromComparisonMs(fromMs, semantics);
      if (!fromWall) return 0;
      const months =
        (fromWall.year - initial.year) * 12 + (fromWall.month - initial.month);
      return Math.max(0, Math.floor(months / rule.interval) - 1);
    }
    case "YEARLY": {
      const fromWall = wallFromComparisonMs(fromMs, semantics);
      if (!fromWall) return 0;
      const years = fromWall.year - initial.year;
      return Math.max(0, Math.floor(years / rule.interval) - 1);
    }
  }
}

function wallFromComparisonMs(
  ms: number,
  semantics: RecurrenceSemantics
): WallTime | null {
  if (Number.isNaN(ms)) return null;
  // instantForComparison for floating/all-day uses wallEpoch, so the reverse
  // is UTC-parts of that epoch — not a timezone conversion.
  if (semantics !== "zoned") {
    const date = new Date(ms);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      millisecond: date.getUTCMilliseconds(),
    };
  }
  // Zoned fromMs is a real UTC instant; month/year distance only needs the
  // UTC calendar of that instant for a conservative lower bound.
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds(),
  };
}

export function applyRecurrenceExceptions(
  instances: readonly RecurrenceInstance[],
  exceptions: readonly RecurrenceException[]
): RecurrenceInstance[] {
  const occurrenceExceptions = new Map(
    exceptions
      .filter((exception) => (exception.scope ?? "occurrence") === "occurrence")
      .map((exception) => [exception.originalStart, exception])
  );
  const futureExceptions = exceptions
    .filter((exception) => exception.scope === "future")
    .sort((left, right) =>
      left.originalStart.localeCompare(right.originalStart)
    );
  return instances.flatMap((instance) => {
    let future: RecurrenceException | undefined;
    for (const candidate of futureExceptions) {
      if (candidate.originalStart > instance.originalStart) break;
      future = candidate;
    }
    const exception =
      occurrenceExceptions.get(instance.originalStart) ?? future;
    if (!exception) return [instance];
    if (exception.action === "skip") return [];
    if (exception.start === undefined) return [instance];
    if ((exception.scope ?? "occurrence") === "occurrence") {
      return [{ ...instance, start: exception.start }];
    }
    const delta = wallDeltaMs(exception.originalStart, exception.start);
    return delta === null
      ? [{ ...instance, start: exception.start }]
      : [{ ...instance, start: shiftTemporal(instance.start, delta) }];
  });
}

/**
 * Shift a wall-clock or zoned instant by `deltaMs` without converting floating
 * / all-day strings through the host's local timezone.
 */
export function shiftTemporal(value: string, deltaMs: number): string {
  if (isZonedInstant(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms + deltaMs).toISOString();
  }
  const wall = parseWallIso(value);
  if (!wall) return value;
  const shifted = new Date(wallEpoch(wall) + deltaMs);
  const next: WallTime = {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  };
  return wallIso(next, value.includes("T"));
}

function isZonedInstant(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
}

function wallDeltaMs(from: string, to: string): number | null {
  if (isZonedInstant(from) || isZonedInstant(to)) {
    const delta = Date.parse(to) - Date.parse(from);
    return Number.isNaN(delta) ? null : delta;
  }
  const fromWall = parseWallIso(from);
  const toWall = parseWallIso(to);
  if (!fromWall || !toWall) return null;
  return wallEpoch(toWall) - wallEpoch(fromWall);
}

export function nextOccurrence(input: NextOccurrenceInput): string | null {
  const anchor = input.anchor ?? "scheduled";
  const start = anchor === "completion" ? input.after : input.scheduledStart;
  const afterMs = Date.parse(input.after);
  if (Number.isNaN(afterMs)) return null;
  const horizon = new Date(afterMs + 10 * 366 * 86_400_000).toISOString();
  const occurrences = expandRecurrence({
    rrule: input.rrule,
    start,
    rangeFrom: input.after,
    rangeTo: horizon,
    ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
    semantics: "zoned",
    maxInstances: 4_000,
  });
  return (
    occurrences.find((occurrence) => Date.parse(occurrence.start) > afterMs)
      ?.start ?? null
  );
}

// The single member-facing summariser lives in ./recurrence-summary.ts (this
// file stays at the engine layer, under the 500-line cap); the missed-period
// collapse lives in ./recurrence-collapse.ts. Both reach the engine from here,
// never the other way round.
