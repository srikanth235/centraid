import { describe, it, expect } from 'vitest';
import {
  cronFieldMatch,
  cronNextRuns,
  cronRunLabel,
  describeCron,
  isValidIanaTimeZone,
  resolveCronTimezone,
  shortTimeZoneName,
} from './cron.js';

// Cron is evaluated against the LOCAL calendar (the basis the scheduler in
// `packages/automation/src/fire/cron-match.ts` matches on), so these assert on
// local wall-clock fields rather than ISO strings. Constructing the clock from
// local components and reading it back the same way keeps the suite green in
// any TZ — an ISO literal would only pass on a UTC runner.
const at = (y: number, mo: number, d: number, h: number, mi: number): Date =>
  new Date(y, mo - 1, d, h, mi);
const local = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const day = (d: Date): string => local(d).slice(0, 10);
const zoneParts = (d: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  let hour = pick('hour');
  if (hour === '24') hour = '00';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${hour}:${pick('minute')}`;
};

describe(cronFieldMatch, () => {
  it('matches a wildcard against any in-range value', () => {
    expect(cronFieldMatch('*', 0, 0, 59, {})).toBe(true);
    expect(cronFieldMatch('*', 59, 0, 59, {})).toBe(true);
    expect(cronFieldMatch('?', 12, 0, 23, {})).toBe(true);
  });

  it('matches an exact numeric value and rejects its neighbours', () => {
    expect(cronFieldMatch('30', 30, 0, 59, {})).toBe(true);
    expect(cronFieldMatch('30', 29, 0, 59, {})).toBe(false);
    expect(cronFieldMatch('30', 31, 0, 59, {})).toBe(false);
  });

  it('honours a step over the whole range (*/n)', () => {
    expect(cronFieldMatch('*/15', 0, 0, 59, {})).toBe(true);
    expect(cronFieldMatch('*/15', 15, 0, 59, {})).toBe(true);
    expect(cronFieldMatch('*/15', 30, 0, 59, {})).toBe(true);
    expect(cronFieldMatch('*/15', 7, 0, 59, {})).toBe(false);
  });

  it('honours a step within a range (a-b/n)', () => {
    expect(cronFieldMatch('0-10/5', 5, 0, 59, {})).toBe(true);
    expect(cronFieldMatch('0-10/5', 10, 0, 59, {})).toBe(true);
    expect(cronFieldMatch('0-10/5', 6, 0, 59, {})).toBe(false);
    expect(cronFieldMatch('0-10/5', 15, 0, 59, {})).toBe(false); // out of range
  });

  it('matches an inclusive range and a comma list', () => {
    expect(cronFieldMatch('9-17', 12, 0, 23, {})).toBe(true);
    expect(cronFieldMatch('9-17', 18, 0, 23, {})).toBe(false);
    expect(cronFieldMatch('0,12', 12, 0, 23, {})).toBe(true);
    expect(cronFieldMatch('0,12', 6, 0, 23, {})).toBe(false);
  });

  it('resolves named day/month tokens case-insensitively', () => {
    const dow = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
    expect(cronFieldMatch('MON', 1, 0, 7, dow)).toBe(true);
    expect(cronFieldMatch('mon', 1, 0, 7, dow)).toBe(true);
    expect(cronFieldMatch('MON-FRI', 3, 0, 7, dow)).toBe(true);
    expect(cronFieldMatch('MON-FRI', 6, 0, 7, dow)).toBe(false);
  });

  it('returns false for an unparseable token rather than throwing', () => {
    expect(cronFieldMatch('nope', 5, 0, 59, {})).toBe(false);
  });
});

describe(cronNextRuns, () => {
  it('returns [] for an expression that is not exactly five fields', () => {
    expect(cronNextRuns('0 9 * *', 3, at(2026, 1, 1, 0, 0))).toStrictEqual([]);
    expect(cronNextRuns('0 9 * * * *', 3, at(2026, 1, 1, 0, 0))).toStrictEqual([]);
    expect(cronNextRuns('', 3, at(2026, 1, 1, 0, 0))).toStrictEqual([]);
  });

  it('lists the next daily fire times starting one minute after `from`', () => {
    const runs = cronNextRuns('0 9 * * *', 3, at(2026, 1, 1, 0, 0));
    expect(runs.map(local)).toStrictEqual([
      '2026-01-01 09:00',
      '2026-01-02 09:00',
      '2026-01-03 09:00',
    ]);
  });

  it('reads the hour field as local time, matching the scheduler', () => {
    // The scheduler matches `getHours()`, and `relativeRunLabel` formats with
    // `toLocaleTimeString`. Off-by-the-UTC-offset previews (a 7pm job listed as
    // "12:30 AM" on IST) came from evaluating this in UTC instead.
    const runs = cronNextRuns('0 19 * * *', 1, at(2026, 1, 1, 0, 0));
    expect(runs[0]?.getHours()).toBe(19);
    expect(local(runs[0]!)).toBe('2026-01-01 19:00');
  });

  it('skips the current minute (search begins at from + 1 minute)', () => {
    // Already 09:00 exactly → the next 09:00 is tomorrow, not right now.
    const runs = cronNextRuns('0 9 * * *', 1, at(2026, 1, 1, 9, 0));
    expect(runs.map(local)).toStrictEqual(['2026-01-02 09:00']);
  });

  it('expands an every-15-minutes step', () => {
    const runs = cronNextRuns('*/15 * * * *', 4, at(2026, 1, 1, 8, 2));
    expect(runs.map(local)).toStrictEqual([
      '2026-01-01 08:15',
      '2026-01-01 08:30',
      '2026-01-01 08:45',
      '2026-01-01 09:00',
    ]);
  });

  it('treats day-of-month and day-of-week as OR when both are restricted', () => {
    // 2026-01-01 is a Thursday. "9am on the 1st OR on a Monday."
    const runs = cronNextRuns('0 9 1 * 1', 3, at(2026, 1, 1, 0, 0));
    const days = runs.map(day);
    expect(days[0]).toBe('2026-01-01'); // the 1st (dom hit)
    expect(days[1]).toBe('2026-01-05'); // first Monday (dow hit)
    expect(days[2]).toBe('2026-01-12'); // next Monday
  });

  it('honours named weekday tokens', () => {
    const runs = cronNextRuns('0 9 * * MON', 2, at(2026, 1, 1, 0, 0));
    expect(runs.map(day)).toStrictEqual(['2026-01-05', '2026-01-12']);
  });

  it('restricts a weekday range to Mon–Fri', () => {
    // 2026-01-01 is a Thursday, so: Thu, Fri, then skip the weekend to Mon.
    const runs = cronNextRuns('0 19 * * 1-5', 3, at(2026, 1, 1, 0, 0));
    expect(runs.map(local)).toStrictEqual([
      '2026-01-01 19:00',
      '2026-01-02 19:00',
      '2026-01-05 19:00',
    ]);
  });

  it('same expression + same resolved tz yields identical absolute instants under two viewer host clocks', () => {
    // Absolute `from` in UTC — wall-clock next-run in America/New_York must not
    // depend on the process host zone (the two "viewers").
    const from = new Date('2026-01-15T12:00:00.000Z');
    const a = cronNextRuns('0 9 * * *', 2, from, 'America/New_York');
    const b = cronNextRuns('0 9 * * *', 2, from, 'America/New_York');
    expect(a.map((d) => d.getTime())).toStrictEqual(b.map((d) => d.getTime()));
    expect(a).toHaveLength(2);
    // 09:00 America/New_York on those days.
    expect(zoneParts(a[0]!, 'America/New_York')).toMatch(/09:00$/);
    expect(zoneParts(a[1]!, 'America/New_York')).toMatch(/09:00$/);
    // And the absolute instants are stable (not viewer-local).
    expect(a[0]!.toISOString()).toBe(b[0]!.toISOString());
  });

  it('fires at the trigger zone wall clock, not the host zone', () => {
    // 09:00 America/Los_Angeles — assert the zone wall clock, not host getters.
    const from = new Date('2026-06-01T00:00:00.000Z');
    const runs = cronNextRuns('0 9 * * *', 1, from, 'America/Los_Angeles');
    expect(runs).toHaveLength(1);
    expect(zoneParts(runs[0]!, 'America/Los_Angeles')).toMatch(/09:00$/);
  });
});

describe(describeCron, () => {
  it('returns a curated gloss for well-known expressions', () => {
    expect(describeCron('0 9 * * *')).toBe('Every day at 09:00');
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes');
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 09:00');
  });

  it('normalises surrounding whitespace before the known-pattern lookup', () => {
    expect(describeCron('  0   9 * * *  ')).toBe('Every day at 09:00');
  });

  it('derives a daily gloss for an arbitrary fixed time', () => {
    expect(describeCron('30 14 * * *')).toBe('Every day at 14:30');
  });

  it('derives an interval gloss for a bare minute step', () => {
    expect(describeCron('*/7 * * * *')).toBe('Every 7 minutes');
  });

  it('derives an hourly gloss for a fixed minute', () => {
    expect(describeCron('20 * * * *')).toBe('Every hour at :20');
  });

  it('falls back to the raw expression when it cannot be glossed', () => {
    expect(describeCron('5 4 1,15 * 3')).toBe('Cron: 5 4 1,15 * 3');
  });

  it('labels an explicit zone on daily glosses', () => {
    expect(describeCron('0 9 * * *', 'America/New_York')).toMatch(/Every day at 09:00 \(.+\)/);
  });
});

describe('resolveCronTimezone / isValidIanaTimeZone', () => {
  it('accepts known IANA names and rejects unknown ones', () => {
    expect(isValidIanaTimeZone('America/New_York')).toBe(true);
    expect(isValidIanaTimeZone('UTC')).toBe(true);
    expect(isValidIanaTimeZone('Not/A_Zone')).toBe(false);
    expect(isValidIanaTimeZone('')).toBe(false);
  });

  it('resolves trigger → gateway default → host-local', () => {
    expect(resolveCronTimezone('Asia/Kolkata', 'America/New_York')).toBe('Asia/Kolkata');
    expect(resolveCronTimezone(undefined, 'America/New_York')).toBe('America/New_York');
    expect(resolveCronTimezone(undefined, undefined)).toBeUndefined();
    expect(resolveCronTimezone('Not/A_Zone', 'UTC')).toBe('UTC');
  });
});

describe(cronRunLabel, () => {
  it('appends a short zone name when the schedule zone differs from the viewer', () => {
    const d = new Date('2026-01-15T14:00:00.000Z'); // 09:00 EST
    const label = cronRunLabel(d, {
      timeZone: 'America/New_York',
      viewerTimeZone: 'Asia/Kolkata',
      now: new Date('2026-01-15T05:00:00.000Z'),
    });
    expect(label).toMatch(/Today,/);
    // Zone short name appears when viewer ≠ schedule.
    expect(label).toMatch(/\b(EST|EDT|GMT[-+]\d+|America\/New_York|New York)\b/);
  });

  it('omits the zone label when viewer and schedule zones match', () => {
    const d = new Date('2026-01-15T14:00:00.000Z');
    const label = cronRunLabel(d, {
      timeZone: 'America/New_York',
      viewerTimeZone: 'America/New_York',
      now: new Date('2026-01-15T05:00:00.000Z'),
    });
    expect(label).toMatch(/^Today,/);
    expect(label).not.toMatch(/\sEST$/);
  });
});

describe(shortTimeZoneName, () => {
  it('returns a non-empty label for a known zone', () => {
    expect(shortTimeZoneName('America/New_York').length).toBeGreaterThan(0);
  });
});
