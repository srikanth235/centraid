import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cronMatches } from './cron-match.js';

// Local-time dates (the matcher reads the local wall clock). 2026-01-01 is a
// Thursday; 2026-01-04 a Sunday; 2026-01-05 a Monday.
const at = (y: number, mo: number, d: number, h: number, mi: number): Date =>
  new Date(y, mo - 1, d, h, mi, 0, 0);

describe('cronMatches', () => {
  it('matches a single minute/hour and rejects neighbours', () => {
    assert.equal(cronMatches('0 8 * * *', at(2026, 1, 1, 8, 0)), true);
    assert.equal(cronMatches('0 8 * * *', at(2026, 1, 1, 8, 1)), false);
    assert.equal(cronMatches('0 8 * * *', at(2026, 1, 1, 9, 0)), false);
    assert.equal(cronMatches('30 9 * * *', at(2026, 1, 1, 9, 30)), true);
  });

  it('handles step, range, and list fields', () => {
    assert.equal(cronMatches('*/15 * * * *', at(2026, 1, 1, 3, 0)), true);
    assert.equal(cronMatches('*/15 * * * *', at(2026, 1, 1, 3, 30)), true);
    assert.equal(cronMatches('*/15 * * * *', at(2026, 1, 1, 3, 7)), false);
    assert.equal(cronMatches('0 9-17 * * *', at(2026, 1, 1, 12, 0)), true);
    assert.equal(cronMatches('0 9-17 * * *', at(2026, 1, 1, 18, 0)), false);
    assert.equal(cronMatches('0 0,12 * * *', at(2026, 1, 1, 12, 0)), true);
    assert.equal(cronMatches('0 0,12 * * *', at(2026, 1, 1, 6, 0)), false);
    assert.equal(cronMatches('0-10/5 * * * *', at(2026, 1, 1, 0, 5)), true);
    assert.equal(cronMatches('0-10/5 * * * *', at(2026, 1, 1, 0, 6)), false);
  });

  it('applies day-of-month and day-of-week with OR semantics', () => {
    // dow only: Monday 09:00.
    assert.equal(cronMatches('0 9 * * 1', at(2026, 1, 5, 9, 0)), true); // Monday
    assert.equal(cronMatches('0 9 * * 1', at(2026, 1, 6, 9, 0)), false); // Tuesday
    // dom only: the 1st.
    assert.equal(cronMatches('0 9 1 * *', at(2026, 1, 1, 9, 0)), true);
    assert.equal(cronMatches('0 9 1 * *', at(2026, 1, 2, 9, 0)), false);
    // both restricted → either matches (the 1st is a Thursday, not Monday).
    assert.equal(cronMatches('0 9 1 * 1', at(2026, 1, 1, 9, 0)), true); // dom hit
    assert.equal(cronMatches('0 9 1 * 1', at(2026, 1, 5, 9, 0)), true); // dow hit
    assert.equal(cronMatches('0 9 1 * 1', at(2026, 1, 6, 9, 0)), false); // neither
  });

  it('treats 0 and 7 as Sunday', () => {
    assert.equal(cronMatches('0 9 * * 0', at(2026, 1, 4, 9, 0)), true); // Sunday
    assert.equal(cronMatches('0 9 * * 7', at(2026, 1, 4, 9, 0)), true); // Sunday
    assert.equal(cronMatches('0 9 * * 0', at(2026, 1, 5, 9, 0)), false); // Monday
  });

  it('treats ? as a wildcard', () => {
    assert.equal(cronMatches('0 9 ? * *', at(2026, 1, 1, 9, 0)), true);
  });

  it('fails safe on unreadable fields and wrong field counts', () => {
    // Weekday names aren't supported — never matches rather than mis-firing.
    assert.equal(cronMatches('0 9 * * MON', at(2026, 1, 5, 9, 0)), false);
    assert.equal(cronMatches('0 9 * *', at(2026, 1, 1, 9, 0)), false); // 4 fields
    assert.equal(cronMatches('0 9 * * * *', at(2026, 1, 1, 9, 0)), false); // 6 fields
  });
});
