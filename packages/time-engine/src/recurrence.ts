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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseRrule(value: string): ParsedRrule | null {
  const parts = new Map<string, string>();
  for (const segment of value.split(";")) {
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
  let emitted = 0;
  let period = 0;
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
    .toSorted((left, right) =>
      left.originalStart.localeCompare(right.originalStart)
    );
  return instances.flatMap((instance) => {
    const future = futureExceptions.findLast(
      (candidate) => candidate.originalStart <= instance.originalStart
    );
    const exception =
      occurrenceExceptions.get(instance.originalStart) ?? future;
    if (!exception) return [instance];
    if (exception.action === "skip") return [];
    if (exception.start === undefined) return [instance];
    if ((exception.scope ?? "occurrence") === "occurrence") {
      return [{ ...instance, start: exception.start }];
    }
    const delta =
      Date.parse(exception.start) - Date.parse(exception.originalStart);
    return Number.isNaN(delta)
      ? [{ ...instance, start: exception.start }]
      : [
          {
            ...instance,
            start: new Date(Date.parse(instance.start) + delta).toISOString(),
          },
        ];
  });
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

const FREQ_LABELS: Record<ParsedRrule["freq"], string> = {
  DAILY: "day",
  WEEKLY: "week",
  MONTHLY: "month",
  YEARLY: "year",
};

export function describeRecurrence(value: string): string | null {
  const rule = parseRrule(value);
  if (!rule) return null;
  const unit = FREQ_LABELS[rule.freq];
  const cadence =
    rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`;
  const days =
    rule.byDay && rule.byDay.length > 0 ? ` on ${rule.byDay.join(", ")}` : "";
  const end =
    rule.count === undefined
      ? rule.until
        ? ` until ${rule.until}`
        : ""
      : `, ${rule.count} times`;
  return `${cadence}${days}${end}`;
}
