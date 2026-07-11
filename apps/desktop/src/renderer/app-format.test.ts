import { afterEach, describe, expect, it } from 'vitest';
import { cronToHuman, formatWhereClauses } from './app-format.js';

// cron digits are UTC; the display promises the user's local wall-clock time.
// process.env.TZ swaps the local zone at runtime (POSIX), letting the tests
// pin conversions without mocking Date. Zones chosen have no DST.
const realTz = process.env.TZ;

afterEach(() => {
  if (realTz === undefined) delete process.env.TZ;
  else process.env.TZ = realTz;
});

describe('cronToHuman UTC→local conversion', () => {
  it('renders the raw digits when local time IS UTC', () => {
    process.env.TZ = 'UTC';
    expect(cronToHuman('30 17 * * *')).toBe('Daily at 5:30 PM');
    expect(cronToHuman('0 17 * * 1-5')).toBe('Weekdays at 5:00 PM');
    expect(cronToHuman('0 9 * * 0')).toBe('Sundays at 9:00 AM');
  });

  it('converts to local time in a positive-offset zone (UTC+5:30)', () => {
    process.env.TZ = 'Asia/Kolkata';
    expect(cronToHuman('30 17 * * *')).toBe('Daily at 11:00 PM');
    expect(cronToHuman('30 3 * * 1-5')).toBe('Weekdays at 9:00 AM');
  });

  it('shifts single-day labels forward when conversion crosses midnight', () => {
    process.env.TZ = 'Asia/Kolkata'; // Friday 20:30 UTC = Saturday 2:00 AM IST
    expect(cronToHuman('30 20 * * 5')).toBe('Saturdays at 2:00 AM');
  });

  it('shifts single-day labels backward in a negative-offset zone', () => {
    process.env.TZ = 'America/Phoenix'; // Monday 2:00 UTC = Sunday 7:00 PM MST
    expect(cronToHuman('0 2 * * 1')).toBe('Sundays at 7:00 PM');
    expect(cronToHuman('0 2 * * 0')).toBe('Saturdays at 7:00 PM');
  });

  it('falls back to the raw expression for weekday/weekend sets that cross midnight', () => {
    process.env.TZ = 'Asia/Kolkata'; // 20:00 UTC weekdays = 1:30 AM Tue–Sat locally
    expect(cronToHuman('0 20 * * 1-5')).toBe('0 20 * * 1-5');
    expect(cronToHuman('0 20 * * 0,6')).toBe('0 20 * * 0,6');
  });

  it('leaves timeless patterns untouched', () => {
    process.env.TZ = 'Asia/Kolkata';
    expect(cronToHuman('*/5 * * * *')).toBe('Every 5 minutes');
    expect(cronToHuman('0 * * * *')).toBe('Hourly');
    expect(cronToHuman('not a cron')).toBe('not a cron');
  });
});

// Shared by the builder's trigger form (BuilderAutomationTriggers, which
// re-exports this) and the automation view screen's condition-detail
// rendering (automationsData.ts) — one formatter, one compact shape.
describe('formatWhereClauses', () => {
  it('returns null for an empty/absent where', () => {
    expect(formatWhereClauses(undefined)).toBeNull();
    expect(formatWhereClauses([])).toBeNull();
  });

  it('pretty-prints one clause per line, quoting non-numeric values', () => {
    const out = formatWhereClauses([
      { column: 'status', op: 'eq', value: 'open' },
      { column: 'days_left', op: 'within-days', value: 3 },
      { column: 'archived_at', op: 'is-null' },
    ]);
    expect(out).toBe('status eq "open"\ndays_left within-days 3\narchived_at is-null');
  });

  it('falls back to raw JSON for a shape it cannot structurally print', () => {
    const weird = [{ nope: true }];
    expect(formatWhereClauses(weird)).toBe(JSON.stringify(weird, null, 2));
  });
});
