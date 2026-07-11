// Hand-rolled RFC 5545 §3.3.10 RRULE subset — no external dependency, same
// posture as the automation package's cron-match.ts ("covers exactly what
// the config pane needs"). Supports FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with
// INTERVAL, COUNT, UNTIL and BYDAY (weekly only). Anything else in the
// string is ignored rather than rejected — an unknown part degrades to the
// bare FREQ/INTERVAL cadence instead of refusing the whole rule.
//
// Dates are ISO 8601 strings throughout, UTC, no timezone math — start_tz is
// carried separately by the caller and never enters this module.

const DAY_TOKENS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
type DayToken = (typeof DAY_TOKENS)[number];

export interface ParsedRrule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  until?: string;
  byDay?: DayToken[];
}

/** Parse `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10` into structured parts, or null if unparseable. */
export function parseRrule(rrule: string): ParsedRrule | null {
  const parts = new Map<string, string>();
  for (const seg of rrule.split(';')) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    parts.set(seg.slice(0, eq).trim().toUpperCase(), seg.slice(eq + 1).trim());
  }
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
  const interval = Math.max(1, Number.parseInt(parts.get('INTERVAL') ?? '1', 10) || 1);
  const countRaw = parts.get('COUNT');
  const count = countRaw ? Math.max(1, Number.parseInt(countRaw, 10) || 0) || undefined : undefined;
  const until = parts.get('UNTIL') || undefined;
  const byDayRaw = parts.get('BYDAY');
  const byDay = byDayRaw
    ? (byDayRaw
        .split(',')
        .map((d) => d.trim().toUpperCase())
        .filter((d): d is DayToken => (DAY_TOKENS as readonly string[]).includes(d)) as DayToken[])
    : undefined;
  return { freq, interval, count, until, byDay: byDay && byDay.length > 0 ? byDay : undefined };
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d.getTime());
  next.setUTCDate(next.getUTCDate() + n);
  return next;
}

function addMonths(d: Date, n: number): Date {
  const next = new Date(d.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + n);
  const daysInMonth = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, daysInMonth));
  return next;
}

/**
 * The occurrences of `rrule` anchored at `dtstartIso`, in `[rangeFromIso,
 * rangeToIso)`, capped at `maxInstances` (default 366) as a hard backstop
 * against a pathological rule (e.g. DAILY with no COUNT/UNTIL) walking
 * forever. Returns dtstart ISO strings only — the caller derives each
 * instance's dtend by re-applying the original event's duration.
 */
export function expandRrule(
  rrule: string,
  dtstartIso: string,
  rangeFromIso: string,
  rangeToIso: string,
  maxInstances = 366,
): string[] {
  const parsed = parseRrule(rrule);
  const dtstart = new Date(dtstartIso);
  if (!parsed || Number.isNaN(dtstart.getTime())) return [];
  const rangeFrom = new Date(rangeFromIso);
  const rangeTo = new Date(rangeToIso);
  const untilRaw = parsed.until ? new Date(parsed.until) : null;
  const until = untilRaw && !Number.isNaN(untilRaw.getTime()) ? untilRaw : null;
  const out: string[] = [];
  let occurrenceIndex = 0;

  // Every cadence anchors back to the ORIGINAL dtstart, not the previous
  // occurrence — chaining `addMonths` off a drifted cursor walks Jan 31 →
  // Feb 28 → Mar 28 instead of the RFC 5545-correct Jan 31 → Feb 28 → Mar 31.
  const cursorAt = (k: number): Date => {
    switch (parsed.freq) {
      case 'DAILY':
        return addDays(dtstart, k * parsed.interval);
      case 'WEEKLY':
        return addDays(dtstart, k * 7 * parsed.interval);
      case 'MONTHLY':
        return addMonths(dtstart, k * parsed.interval);
      case 'YEARLY':
        return addMonths(dtstart, k * 12 * parsed.interval);
    }
  };

  // Weekly + BYDAY expands each anchor week into its named weekdays, so the
  // walk is per-week rather than per-occurrence.
  if (parsed.freq === 'WEEKLY' && parsed.byDay) {
    const weekStart = addDays(dtstart, -dtstart.getUTCDay());
    let week = weekStart;
    let guard = 0;
    while (guard < maxInstances * 8) {
      guard += 1;
      for (const token of parsed.byDay) {
        const offset = DAY_TOKENS.indexOf(token);
        const d = addDays(week, offset);
        if (d.getTime() < dtstart.getTime()) continue;
        if (until && d.getTime() > until.getTime()) continue;
        if (parsed.count !== undefined && occurrenceIndex >= parsed.count) continue;
        occurrenceIndex += 1;
        if (d.getTime() >= rangeFrom.getTime() && d.getTime() < rangeTo.getTime()) {
          out.push(d.toISOString());
        }
      }
      if (
        (parsed.count !== undefined && occurrenceIndex >= parsed.count) ||
        (until && week.getTime() > until.getTime()) ||
        week.getTime() > rangeTo.getTime() ||
        out.length >= maxInstances
      ) {
        break;
      }
      week = addDays(week, 7 * parsed.interval);
    }
    return out.slice(0, maxInstances).sort();
  }

  // Occurrences are monotonically increasing, so once the cursor reaches the
  // range's upper bound no further iteration can land inside it — that's
  // the real backstop; maxInstances only guards a pathological open rule
  // whose range is itself unbounded.
  let k = 0;
  let guard = 0;
  while (out.length < maxInstances && guard < maxInstances * 4) {
    guard += 1;
    const cursor = cursorAt(k);
    if (cursor.getTime() >= rangeTo.getTime()) break;
    if (until && cursor.getTime() > until.getTime()) break;
    if (parsed.count !== undefined && occurrenceIndex >= parsed.count) break;
    occurrenceIndex += 1;
    if (cursor.getTime() >= rangeFrom.getTime()) {
      out.push(cursor.toISOString());
    }
    k += 1;
  }
  return out;
}

/**
 * The single next occurrence strictly after `afterIso`, or null if the
 * series is exhausted (COUNT/UNTIL reached) or the rule doesn't parse. Tasks
 * use this on completion — one row advances in place rather than a
 * calendar-style range materializing many instances at once.
 */
export function nextOccurrence(rrule: string, dtstartIso: string, afterIso: string): string | null {
  const parsed = parseRrule(rrule);
  const dtstart = new Date(dtstartIso);
  const after = new Date(afterIso);
  if (!parsed || Number.isNaN(dtstart.getTime()) || Number.isNaN(after.getTime())) return null;
  // A year of headroom past `after` is enough runway for every supported
  // cadence (including YEARLY×1) to surface its next hit, if one exists.
  const horizon = new Date(after.getTime() + 366 * 86400000 + 1).toISOString();
  const hits = expandRrule(rrule, dtstartIso, after.toISOString(), horizon, 400);
  const next = hits.find((h) => new Date(h).getTime() > after.getTime());
  return next ?? null;
}
