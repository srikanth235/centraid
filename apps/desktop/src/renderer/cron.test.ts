import { describe, it, expect } from 'vitest';
import { cronFieldMatch, cronNextRuns, describeCron } from './cron.js';

// Helpers: cron is evaluated in UTC, so pin every clock to an explicit UTC date.
const utc = (s: string): Date => new Date(s);
const iso = (d: Date): string => d.toISOString();

describe('cronFieldMatch', () => {
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

describe('cronNextRuns', () => {
  it('returns [] for an expression that is not exactly five fields', () => {
    expect(cronNextRuns('0 9 * *', 3, utc('2026-01-01T00:00:00Z'))).toEqual([]);
    expect(cronNextRuns('0 9 * * * *', 3, utc('2026-01-01T00:00:00Z'))).toEqual([]);
    expect(cronNextRuns('', 3, utc('2026-01-01T00:00:00Z'))).toEqual([]);
  });

  it('lists the next daily fire times starting one minute after `from`', () => {
    const runs = cronNextRuns('0 9 * * *', 3, utc('2026-01-01T00:00:00Z'));
    expect(runs.map(iso)).toEqual([
      '2026-01-01T09:00:00.000Z',
      '2026-01-02T09:00:00.000Z',
      '2026-01-03T09:00:00.000Z',
    ]);
  });

  it('skips the current minute (search begins at from + 1 minute)', () => {
    // Already 09:00 exactly → the next 09:00 is tomorrow, not right now.
    const runs = cronNextRuns('0 9 * * *', 1, utc('2026-01-01T09:00:00Z'));
    expect(runs.map(iso)).toEqual(['2026-01-02T09:00:00.000Z']);
  });

  it('expands an every-15-minutes step', () => {
    const runs = cronNextRuns('*/15 * * * *', 4, utc('2026-01-01T08:02:00Z'));
    expect(runs.map(iso)).toEqual([
      '2026-01-01T08:15:00.000Z',
      '2026-01-01T08:30:00.000Z',
      '2026-01-01T08:45:00.000Z',
      '2026-01-01T09:00:00.000Z',
    ]);
  });

  it('treats day-of-month and day-of-week as OR when both are restricted', () => {
    // 2026-01-01 is a Thursday. "9am on the 1st OR on a Monday."
    const runs = cronNextRuns('0 9 1 * 1', 3, utc('2026-01-01T00:00:00Z'));
    const days = runs.map((d) => d.toISOString().slice(0, 10));
    expect(days[0]).toBe('2026-01-01'); // the 1st (dom hit)
    expect(days[1]).toBe('2026-01-05'); // first Monday (dow hit)
    expect(days[2]).toBe('2026-01-12'); // next Monday
  });

  it('honours named weekday tokens', () => {
    const runs = cronNextRuns('0 9 * * MON', 2, utc('2026-01-01T00:00:00Z'));
    expect(runs.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-01-05', '2026-01-12']);
  });
});

describe('describeCron', () => {
  it('returns a curated gloss for well-known expressions', () => {
    expect(describeCron('0 9 * * *')).toBe('Every day at 09:00 UTC');
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes');
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 09:00 UTC');
  });

  it('normalises surrounding whitespace before the known-pattern lookup', () => {
    expect(describeCron('  0   9 * * *  ')).toBe('Every day at 09:00 UTC');
  });

  it('derives a daily gloss for an arbitrary fixed time', () => {
    expect(describeCron('30 14 * * *')).toBe('Every day at 14:30 UTC');
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
});
