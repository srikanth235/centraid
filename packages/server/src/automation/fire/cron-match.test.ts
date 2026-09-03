import { describe, expect, it } from "vitest";

import { resolveCronTimezone, wallClockFields } from "../cron-timezone.js";
import { cronMatches } from "./cron-match.js";

const at = (y: number, mo: number, d: number, h: number, mi: number): Date =>
  new Date(y, mo - 1, d, h, mi, 0, 0);

function atZone(
  timeZone: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  for (let delta = -14 * 60; delta <= 14 * 60; delta++) {
    const candidate = new Date(guess + delta * 60_000);
    const w = wallClockFields(candidate, timeZone);
    if (
      w.year === y &&
      w.month === mo &&
      w.day === d &&
      w.hour === h &&
      w.minute === mi
    ) {
      return candidate;
    }
  }
  throw new Error(
    `could not find instant for ${y}-${mo}-${d} ${h}:${mi} in ${timeZone}`
  );
}

describe(cronMatches, () => {
  it("matches a single minute/hour and rejects neighbours", () => {
    expect(cronMatches("0 8 * * *", at(2026, 1, 1, 8, 0))).toBe(true);
    expect(cronMatches("0 8 * * *", at(2026, 1, 1, 8, 1))).toBe(false);
    expect(cronMatches("0 8 * * *", at(2026, 1, 1, 9, 0))).toBe(false);
    expect(cronMatches("30 9 * * *", at(2026, 1, 1, 9, 30))).toBe(true);
  });

  it("handles step, range, and list fields", () => {
    expect(cronMatches("*/15 * * * *", at(2026, 1, 1, 3, 0))).toBe(true);
    expect(cronMatches("*/15 * * * *", at(2026, 1, 1, 3, 30))).toBe(true);
    expect(cronMatches("*/15 * * * *", at(2026, 1, 1, 3, 7))).toBe(false);
    expect(cronMatches("0 9-17 * * *", at(2026, 1, 1, 12, 0))).toBe(true);
    expect(cronMatches("0 9-17 * * *", at(2026, 1, 1, 18, 0))).toBe(false);
    expect(cronMatches("0 0,12 * * *", at(2026, 1, 1, 12, 0))).toBe(true);
    expect(cronMatches("0 0,12 * * *", at(2026, 1, 1, 6, 0))).toBe(false);
    expect(cronMatches("0-10/5 * * * *", at(2026, 1, 1, 0, 5))).toBe(true);
    expect(cronMatches("0-10/5 * * * *", at(2026, 1, 1, 0, 6))).toBe(false);
  });

  it("applies day-of-month and day-of-week with OR semantics", () => {
    expect(cronMatches("0 9 * * 1", at(2026, 1, 5, 9, 0))).toBe(true); // Monday
    expect(cronMatches("0 9 * * 1", at(2026, 1, 6, 9, 0))).toBe(false); // Tuesday
    expect(cronMatches("0 9 1 * *", at(2026, 1, 1, 9, 0))).toBe(true);
    expect(cronMatches("0 9 1 * *", at(2026, 1, 2, 9, 0))).toBe(false);
    expect(cronMatches("0 9 1 * 1", at(2026, 1, 1, 9, 0))).toBe(true); // dom hit
    expect(cronMatches("0 9 1 * 1", at(2026, 1, 5, 9, 0))).toBe(true); // dow hit
    expect(cronMatches("0 9 1 * 1", at(2026, 1, 6, 9, 0))).toBe(false); // neither
  });

  it("treats 0 and 7 as Sunday", () => {
    expect(cronMatches("0 9 * * 0", at(2026, 1, 4, 9, 0))).toBe(true); // Sunday
    expect(cronMatches("0 9 * * 7", at(2026, 1, 4, 9, 0))).toBe(true); // Sunday
    expect(cronMatches("0 9 * * 0", at(2026, 1, 5, 9, 0))).toBe(false); // Monday
  });

  it("treats ? as a wildcard", () => {
    expect(cronMatches("0 9 ? * *", at(2026, 1, 1, 9, 0))).toBe(true);
  });

  it("fails safe on unreadable fields and wrong field counts", () => {
    expect(cronMatches("0 9 * * MON", at(2026, 1, 5, 9, 0))).toBe(false);
    expect(cronMatches("0 9 * *", at(2026, 1, 1, 9, 0))).toBe(false); // 4 fields
    expect(cronMatches("0 9 * * * *", at(2026, 1, 1, 9, 0))).toBe(false); // 6 fields
  });

  it("matches an explicit IANA zone wall clock even when host local differs", () => {
    const nineEt = atZone("America/New_York", 2026, 6, 15, 9, 0);
    expect(cronMatches("0 9 * * *", nineEt, "America/New_York")).toBe(true);
    const hostHour = nineEt.getHours();
    expect(cronMatches("0 9 * * *", nineEt)).toBe(hostHour === 9);
    const kolkata = wallClockFields(nineEt, "Asia/Kolkata");
    expect(cronMatches("0 9 * * *", nineEt, "Asia/Kolkata")).toBe(
      kolkata.hour === 9 && kolkata.minute === 0
    );
  });

  it("DST gap: spring-forward non-existent wall clock never matches (skip)", () => {
    let matched = false;
    const start = Date.UTC(2026, 2, 7, 12, 0, 0);
    for (let t = start; t < start + 48 * 60 * 60_000; t += 60_000) {
      const d = new Date(t);
      const w = wallClockFields(d, "America/New_York");
      if (
        w.year === 2026 &&
        w.month === 3 &&
        w.day === 8 &&
        cronMatches("30 2 * * *", d, "America/New_York")
      ) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(false);
    const threeThirty = atZone("America/New_York", 2026, 3, 8, 3, 30);
    expect(cronMatches("30 3 * * *", threeThirty, "America/New_York")).toBe(
      true
    );
  });

  it("DST overlap: fall-back wall-clock minute matches once per wall clock", () => {
    let matchCount = 0;
    const start = Date.UTC(2026, 9, 31, 12, 0, 0);
    for (let t = start; t < start + 48 * 60 * 60_000; t += 60_000) {
      const d = new Date(t);
      const w = wallClockFields(d, "America/New_York");
      if (
        w.year === 2026 &&
        w.month === 11 &&
        w.day === 1 &&
        cronMatches("30 1 * * *", d, "America/New_York")
      ) {
        matchCount++;
      }
    }
    expect(matchCount).toBe(2);
  });
});

describe(resolveCronTimezone, () => {
  it("tiers trigger → gateway default → host-local with no geographic fallback", () => {
    expect(resolveCronTimezone("Asia/Kolkata", "America/New_York")).toBe(
      "Asia/Kolkata"
    );
    expect(resolveCronTimezone(undefined, "Europe/London")).toBe(
      "Europe/London"
    );
    expect(resolveCronTimezone(null, null)).toBeUndefined();
    expect(resolveCronTimezone("Not/A_Real_Zone", "UTC")).toBe("UTC");
  });
});
