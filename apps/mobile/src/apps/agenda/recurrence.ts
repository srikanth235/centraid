// Native mirror of the server agenda projection (packages/vault
// recurrence/rrule.ts + packages/blueprints agenda/queries/upcoming.js). Same
// RFC 5545 §3.3.10 subset — FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL,
// COUNT, UNTIL and BYDAY (weekly only) — and the same bounded-walk constants
// (120-day forward runway upstream, 200 materialized rows here). Kept in sync
// with the server so the raw native replica read materializes an identical
// occurrence set. Dates are UTC ISO strings throughout; start_tz is carried on
// the model and never enters the arithmetic.

export interface AgendaEventModel {
  id: string;
  calendarId?: string;
  instanceKey: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  timezone?: string;
  rrule?: string;
  status: string;
  isRecurrenceInstance: boolean;
}

const DAY_TOKENS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
type DayToken = (typeof DAY_TOKENS)[number];

interface ParsedRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  /** Epoch-ms of the inclusive UNTIL bound. */
  until?: number;
  byDay?: DayToken[];
}

/**
 * RFC 5545 UNTIL is written extended (`2026-07-03T00:00:00Z`) or basic
 * (`20260703T000000Z`, the form ICS ingest stores verbatim). `Date.parse`
 * accepts only the former, so a basic UNTIL silently degraded to unbounded —
 * normalize both. The server twins parse the same two shapes so the bound
 * matches. A bare date (`20260703`) is treated as UTC midnight.
 */
export function parseIcalInstant(value: string): number | undefined {
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return direct;
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?Z?$/.exec(value.trim());
  if (!match) return undefined;
  const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  return Number.isNaN(ms) ? undefined : ms;
}

export function parseRule(value: string): ParsedRule | undefined {
  const parts = new Map<string, string>();
  for (const seg of value.split(';')) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    parts.set(seg.slice(0, eq).trim().toUpperCase(), seg.slice(eq + 1).trim());
  }
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') {
    return undefined;
  }
  const interval = Math.max(1, Number.parseInt(parts.get('INTERVAL') ?? '1', 10) || 1);
  const countRaw = parts.get('COUNT');
  const count = countRaw ? Math.max(1, Number.parseInt(countRaw, 10) || 0) || undefined : undefined;
  const untilRaw = parts.get('UNTIL');
  const until = untilRaw ? parseIcalInstant(untilRaw) : undefined;
  const byDayRaw = parts.get('BYDAY');
  const byDay = byDayRaw
    ? (byDayRaw
        .split(',')
        .map((day) => day.trim().toUpperCase())
        .filter((day): day is DayToken =>
          (DAY_TOKENS as readonly string[]).includes(day),
        ) as DayToken[])
    : undefined;
  return {
    freq,
    interval,
    ...(count ? { count } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(byDay && byDay.length > 0 ? { byDay } : {}),
  };
}

function addDays(date: Date, n: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + n);
  return next;
}

// Anchor every cadence back to the ORIGINAL dtstart and clamp the day of month
// so Jan 31 → Feb 28 → Mar 31 (not the bare-setUTCMonth rollover Feb 28 → Mar
// 3). Same arithmetic as the server addMonths.
function addMonths(date: Date, n: number): Date {
  const next = new Date(date);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + n);
  const daysInMonth = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(day, daysInMonth));
  return next;
}

/**
 * The occurrences of `event` overlapping `[from, to)`, capped at `max` rows.
 * Mirrors the server projection: the outer walk is bounded by a step guard
 * (`max * 4`), not by counting every candidate since the anchor, so a series
 * anchored far in the past still surfaces its in-window rows. COUNT/UNTIL
 * terminate the walk the moment the series is exhausted rather than spinning a
 * fixed ceiling of empty steps.
 */
export function expandEvent(
  event: Omit<AgendaEventModel, 'instanceKey' | 'isRecurrenceInstance'>,
  from: Date,
  to: Date,
  max = 200,
): AgendaEventModel[] {
  const anchor = new Date(event.start);
  const duration = Date.parse(event.end) - anchor.getTime();
  const rule = event.rrule ? parseRule(event.rrule) : undefined;
  if (!rule || Number.isNaN(anchor.getTime())) {
    return anchor < to && new Date(event.end) > from
      ? [{ ...event, instanceKey: event.id, isRecurrenceInstance: false }]
      : [];
  }
  const out: AgendaEventModel[] = [];
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const anchorMs = anchor.getTime();
  const push = (candidate: Date): void => {
    const startMs = candidate.getTime();
    // Overlap check keeps a still-running instance visible at the window edge;
    // for the (short) events these rules describe this coincides with the
    // server's start-in-window test whenever no occurrence straddles `from`.
    if (startMs < toMs && startMs + duration > fromMs) {
      out.push({
        ...event,
        start: candidate.toISOString(),
        end: new Date(startMs + duration).toISOString(),
        instanceKey: `${event.id}:${candidate.toISOString()}`,
        isRecurrenceInstance: startMs !== anchorMs,
      });
    }
  };

  let occurrenceIndex = 0;
  // Weekly + BYDAY walks per anchor week and generates every named weekday
  // before the bound check, so an unsorted BYDAY (FR,MO) cannot drop an
  // in-window Monday; the result is sorted once at the end.
  if (rule.freq === 'WEEKLY' && rule.byDay) {
    let week = addDays(anchor, -anchor.getUTCDay());
    let guard = 0;
    while (guard < max * 8 && out.length < max) {
      guard += 1;
      for (const token of rule.byDay) {
        const day = addDays(week, DAY_TOKENS.indexOf(token));
        const dayMs = day.getTime();
        if (dayMs < anchorMs) continue;
        if (rule.until !== undefined && dayMs > rule.until) continue;
        if (rule.count !== undefined && occurrenceIndex >= rule.count) continue;
        occurrenceIndex += 1;
        push(day);
      }
      if (
        (rule.count !== undefined && occurrenceIndex >= rule.count) ||
        (rule.until !== undefined && week.getTime() > rule.until) ||
        week.getTime() > toMs
      ) {
        break;
      }
      week = addDays(week, 7 * rule.interval);
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  const cursorAt = (k: number): Date => {
    if (rule.freq === 'DAILY') return addDays(anchor, k * rule.interval);
    if (rule.freq === 'WEEKLY') return addDays(anchor, k * 7 * rule.interval);
    if (rule.freq === 'MONTHLY') return addMonths(anchor, k * rule.interval);
    return addMonths(anchor, k * 12 * rule.interval);
  };
  let k = 0;
  let guard = 0;
  while (out.length < max && guard < max * 4) {
    guard += 1;
    const cursor = cursorAt(k);
    if (cursor.getTime() >= toMs) break;
    if (rule.until !== undefined && cursor.getTime() > rule.until) break;
    if (rule.count !== undefined && occurrenceIndex >= rule.count) break;
    occurrenceIndex += 1;
    push(cursor);
    k += 1;
  }
  return out;
}
