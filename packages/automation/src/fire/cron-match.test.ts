import { describe, expect, it } from 'vitest';
import { cronMatches } from './cron-match.js';

// Local-time dates (the matcher reads the local wall clock). 2026-01-01 is a
// Thursday; 2026-01-04 a Sunday; 2026-01-05 a Monday.
const at = (y: number, mo: number, d: number, h: number, mi: number): Date =>
  new Date(y, mo - 1, d, h, mi, 0, 0);

describe('cronMatches', () => {
  it('matches a single minute/hour and rejects neighbours', () => {
    expect(cronMatches('0 8 * * *', at(2026, 1, 1, 8, 0))).toBe(true);
    expect(cronMatches('0 8 * * *', at(2026, 1, 1, 8, 1))).toBe(false);
    expect(cronMatches('0 8 * * *', at(2026, 1, 1, 9, 0))).toBe(false);
    expect(cronMatches('30 9 * * *', at(2026, 1, 1, 9, 30))).toBe(true);
  });

  it('handles step, range, and list fields', () => {
    expect(cronMatches('*/15 * * * *', at(2026, 1, 1, 3, 0))).toBe(true);
    expect(cronMatches('*/15 * * * *', at(2026, 1, 1, 3, 30))).toBe(true);
    expect(cronMatches('*/15 * * * *', at(2026, 1, 1, 3, 7))).toBe(false);
    expect(cronMatches('0 9-17 * * *', at(2026, 1, 1, 12, 0))).toBe(true);
    expect(cronMatches('0 9-17 * * *', at(2026, 1, 1, 18, 0))).toBe(false);
    expect(cronMatches('0 0,12 * * *', at(2026, 1, 1, 12, 0))).toBe(true);
    expect(cronMatches('0 0,12 * * *', at(2026, 1, 1, 6, 0))).toBe(false);
    expect(cronMatches('0-10/5 * * * *', at(2026, 1, 1, 0, 5))).toBe(true);
    expect(cronMatches('0-10/5 * * * *', at(2026, 1, 1, 0, 6))).toBe(false);
  });

  it('applies day-of-month and day-of-week with OR semantics', () => {
    // dow only: Monday 09:00.
    expect(cronMatches('0 9 * * 1', at(2026, 1, 5, 9, 0))).toBe(true); // Monday
    expect(cronMatches('0 9 * * 1', at(2026, 1, 6, 9, 0))).toBe(false); // Tuesday
    // dom only: the 1st.
    expect(cronMatches('0 9 1 * *', at(2026, 1, 1, 9, 0))).toBe(true);
    expect(cronMatches('0 9 1 * *', at(2026, 1, 2, 9, 0))).toBe(false);
    // both restricted → either matches (the 1st is a Thursday, not Monday).
    expect(cronMatches('0 9 1 * 1', at(2026, 1, 1, 9, 0))).toBe(true); // dom hit
    expect(cronMatches('0 9 1 * 1', at(2026, 1, 5, 9, 0))).toBe(true); // dow hit
    expect(cronMatches('0 9 1 * 1', at(2026, 1, 6, 9, 0))).toBe(false); // neither
  });

  it('treats 0 and 7 as Sunday', () => {
    expect(cronMatches('0 9 * * 0', at(2026, 1, 4, 9, 0))).toBe(true); // Sunday
    expect(cronMatches('0 9 * * 7', at(2026, 1, 4, 9, 0))).toBe(true); // Sunday
    expect(cronMatches('0 9 * * 0', at(2026, 1, 5, 9, 0))).toBe(false); // Monday
  });

  it('treats ? as a wildcard', () => {
    expect(cronMatches('0 9 ? * *', at(2026, 1, 1, 9, 0))).toBe(true);
  });

  it('fails safe on unreadable fields and wrong field counts', () => {
    // Weekday names aren't supported — never matches rather than mis-firing.
    expect(cronMatches('0 9 * * MON', at(2026, 1, 5, 9, 0))).toBe(false);
    expect(cronMatches('0 9 * *', at(2026, 1, 1, 9, 0))).toBe(false); // 4 fields
    expect(cronMatches('0 9 * * * *', at(2026, 1, 1, 9, 0))).toBe(false); // 6 fields
  });
});
