import { describe, expect, it } from 'vitest';

import { resolveCronTimezone, wallClockFields } from '../cron-timezone.js';
import { cronMatches } from './cron-match.js';

// Local-time dates (the matcher reads the local wall clock when no zone is
// set). 2026-01-01 is a Thursday; 2026-01-04 a Sunday; 2026-01-05 a Monday.
const at = (y: number, mo: number, d: number, h: number, mi: number): Date =>
  new Date(y, mo - 1, d, h, mi, 0, 0);

/** Instant whose wall clock in `timeZone` is the given Y-M-D H:M. */
function atZone(timeZone: string, y: number, mo: number, d: number, h: number, mi: number): Date {
  // Binary search a UTC instant that formats to the desired wall clock.
  // Covers ±14h from a UTC guess — enough for any civil zone.
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  for (let delta = -14 * 60; delta <= 14 * 60; delta++) {
    const candidate = new Date(guess + delta * 60_000);
    const w = wallClockFields(candidate, timeZone);
    if (w.year === y && w.month === mo && w.day === d && w.hour === h && w.minute === mi) {
      return candidate;
    }
  }
  throw new Error(`could not find instant for ${y}-${mo}-${d} ${h}:${mi} in ${timeZone}`);
}

describe(cronMatches, () => {
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

  it('matches an explicit IANA zone wall clock even when host local differs', () => {
    // 09:00 in America/New_York — the absolute instant's host-local hour will
    // usually NOT be 9. The zone-aware matcher must still fire.
    const nineEt = atZone('America/New_York', 2026, 6, 15, 9, 0);
    expect(cronMatches('0 9 * * *', nineEt, 'America/New_York')).toBe(true);
    // Host-local (no zone) only matches if the host happens to also be 09:00.
    const hostHour = nineEt.getHours();
    expect(cronMatches('0 9 * * *', nineEt)).toBe(hostHour === 9);
    // A different zone at the same absolute instant must not spuriously match:
    // it fires only when ITS OWN wall clock also reads 09:00.
    const kolkata = wallClockFields(nineEt, 'Asia/Kolkata');
    expect(cronMatches('0 9 * * *', nineEt, 'Asia/Kolkata')).toBe(
      kolkata.hour === 9 && kolkata.minute === 0,
    );
  });

  it('DST gap: spring-forward non-existent wall clock never matches (skip)', () => {
    // America/New_York springs forward 2026-03-08 02:00 → 03:00.
    // `30 2 * * *` does not exist that civil day → never matches any absolute
    // minute whose wall clock is 2026-03-08 02:30.
    let matched = false;
    // Wide UTC window covering the ET transition day.
    const start = Date.UTC(2026, 2, 7, 12, 0, 0);
    for (let t = start; t < start + 48 * 60 * 60_000; t += 60_000) {
      const d = new Date(t);
      const w = wallClockFields(d, 'America/New_York');
      if (
        w.year === 2026 &&
        w.month === 3 &&
        w.day === 8 &&
        cronMatches('30 2 * * *', d, 'America/New_York')
      ) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(false);
    // Control: 03:30 does exist and matches on the transition day.
    const threeThirty = atZone('America/New_York', 2026, 3, 8, 3, 30);
    expect(cronMatches('30 3 * * *', threeThirty, 'America/New_York')).toBe(true);
  });

  it('DST overlap: fall-back wall-clock minute matches once per wall clock', () => {
    // America/New_York falls back 2026-11-01 02:00 → 01:00.
    // `30 1 * * *` exists twice in absolute time on that civil day; each
    // absolute occurrence matches (the cursor dedupes by wall-clock key so
    // the automation fires once).
    let matchCount = 0;
    const start = Date.UTC(2026, 9, 31, 12, 0, 0);
    for (let t = start; t < start + 48 * 60 * 60_000; t += 60_000) {
      const d = new Date(t);
      const w = wallClockFields(d, 'America/New_York');
      if (
        w.year === 2026 &&
        w.month === 11 &&
        w.day === 1 &&
        cronMatches('30 1 * * *', d, 'America/New_York')
      ) {
        matchCount++;
      }
    }
    // Two absolute minutes carry wall clock 01:30 that day.
    expect(matchCount).toBe(2);
  });
});

describe(resolveCronTimezone, () => {
  it('tiers trigger → gateway default → host-local with no geographic fallback', () => {
    expect(resolveCronTimezone('Asia/Kolkata', 'America/New_York')).toBe('Asia/Kolkata');
    expect(resolveCronTimezone(undefined, 'Europe/London')).toBe('Europe/London');
    expect(resolveCronTimezone(null, null)).toBeUndefined();
    expect(resolveCronTimezone('Not/A_Real_Zone', 'UTC')).toBe('UTC');
  });
});
