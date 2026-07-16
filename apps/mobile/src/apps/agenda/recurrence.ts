export interface AgendaEventModel {
  id: string;
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

interface ParsedRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  until?: number;
  byDay?: number[];
}
const DAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function parseRule(value: string): ParsedRule | undefined {
  const parts = new Map(value.split(';').map((part) => part.split('=', 2) as [string, string]));
  const freq = parts.get('FREQ') as ParsedRule['freq'] | undefined;
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return;
  const count = Number(parts.get('COUNT')) || undefined;
  const untilValue = parts.get('UNTIL');
  const until = untilValue ? Date.parse(untilValue) : undefined;
  const byDay = parts
    .get('BYDAY')
    ?.split(',')
    .map((day) => DAYS[day])
    .filter((day): day is number => day !== undefined);
  return {
    freq,
    interval: Math.max(1, Number(parts.get('INTERVAL')) || 1),
    ...(count ? { count } : {}),
    ...(until && !Number.isNaN(until) ? { until } : {}),
    ...(byDay?.length ? { byDay } : {}),
  };
}

function add(date: Date, rule: ParsedRule, step: number): Date {
  const next = new Date(date);
  if (rule.freq === 'DAILY') next.setUTCDate(next.getUTCDate() + step * rule.interval);
  else if (rule.freq === 'WEEKLY') next.setUTCDate(next.getUTCDate() + step * 7 * rule.interval);
  else if (rule.freq === 'MONTHLY') next.setUTCMonth(next.getUTCMonth() + step * rule.interval);
  else next.setUTCFullYear(next.getUTCFullYear() + step * rule.interval);
  return next;
}

/** Mirrors the bounded server projection for the raw native replica read. */
export function expandEvent(
  event: Omit<AgendaEventModel, 'instanceKey' | 'isRecurrenceInstance'>,
  from: Date,
  to: Date,
  max = 200,
): AgendaEventModel[] {
  const anchor = new Date(event.start);
  const duration = Date.parse(event.end) - anchor.getTime();
  const rule = event.rrule ? parseRule(event.rrule) : undefined;
  if (!rule)
    return anchor < to && new Date(event.end) > from
      ? [{ ...event, instanceKey: event.id, isRecurrenceInstance: false }]
      : [];
  const out: AgendaEventModel[] = [];
  let emitted = 0;
  for (let step = 0; step < 10_000 && emitted < max; step += 1) {
    const candidates =
      rule.freq === 'WEEKLY' && rule.byDay
        ? rule.byDay.map((weekday) => {
            const week = add(anchor, rule, step);
            const date = new Date(week);
            date.setUTCDate(date.getUTCDate() + weekday - anchor.getUTCDay());
            return date;
          })
        : [add(anchor, rule, step)];
    for (const candidate of candidates) {
      if (candidate < anchor) continue;
      if (rule.count && emitted >= rule.count) break;
      if (rule.until && candidate.getTime() > rule.until) break;
      emitted += 1;
      if (candidate >= to) return out;
      if (candidate.getTime() + duration > from.getTime())
        out.push({
          ...event,
          start: candidate.toISOString(),
          end: new Date(candidate.getTime() + duration).toISOString(),
          instanceKey: `${event.id}:${candidate.toISOString()}`,
          isRecurrenceInstance: candidate.getTime() !== anchor.getTime(),
        });
    }
  }
  return out;
}
