// Agenda's HOST-LOCALE surface (#839, G12): the host ICU default decides
// whether 14:05 reads "2:05 PM" or "14:05". Pin every NAMED locale, and pin
// the default as equality with an explicit `undefined`. Build dates from LOCAL
// components, never `Z` instants — only a local constructor makes a wall-clock
// assertion hold in every runner zone.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import {
  eventBounds,
  fmtDay,
  fmtHour,
  fmtTime,
  localDayKey,
  rangeLabel,
  startOfWeek,
  toIsoUtc,
  toLocalInput,
} from "./format.ts";

/** ICU varies U+202F/U+0020/U+00A0 spacing: pin the LOCALE, not the runner. */
function normalize(value: string): string {
  return value.replace(/[  ]/gu, " ");
}

/** A Sunday; 14:05 local exists in every zone (no DST transition). */
const AFTERNOON = new Date(2026, 2, 8, 14, 5);

describe(fmtTime, () => {
  it("renders a twelve-hour locale with a meridiem", () => {
    expect(normalize(fmtTime(AFTERNOON, "en-US"))).toBe("2:05 PM");
  });

  it.each([["en-GB"], ["de-DE"], ["ja-JP"]] as const)(
    "renders %s on a twenty-four-hour clock with no meridiem",
    (locale) => {
      expect(normalize(fmtTime(AFTERNOON, locale))).toBe("14:05");
    }
  );

  it("pads the minute below ten but NOT the hour", () => {
    // `hour: "numeric"` does not pad: "9:05" here, "09" in `fmtHour`, by design.
    const nineOhFive = new Date(2026, 2, 8, 9, 5);
    expect(normalize(fmtTime(nineOhFive, "en-US"))).toBe("9:05 AM");
    expect(normalize(fmtTime(nineOhFive, "en-GB"))).toBe("9:05");
    expect(normalize(fmtHour(9, "en-GB"))).toBe("09");
  });

  it("defaults to the host locale, unchanged by the injectable seam", () => {
    expect(fmtTime(AFTERNOON)).toBe(fmtTime(AFTERNOON, undefined));
  });

  it("falls back to the raw value when the locale itself is unusable", () => {
    expect(fmtTime("2026-03-08T14:05:00.000Z", "not a locale")).toBe(
      "2026-03-08T14:05:00.000Z"
    );
  });

  it("does not throw on an unparseable date", () => {
    // Pins `format.ts`'s `catch` as the LOCALE guard, not a date guard.
    expect(fmtTime("whenever", "en-US")).toBe("Invalid Date");
  });
});

describe(fmtHour, () => {
  it.each([
    ["en-US", "9 AM"],
    ["en-GB", "09"],
    ["de-DE", "09 Uhr"],
    ["ja-JP", "9時"],
  ] as const)("renders the %s grid rail label as %s", (locale, expected) => {
    expect(normalize(fmtHour(9, locale))).toBe(expected);
  });

  it("renders midnight and 23:00 without wrapping in a 24-hour locale", () => {
    expect(normalize(fmtHour(0, "en-GB"))).toBe("00");
    expect(normalize(fmtHour(23, "en-GB"))).toBe("23");
    expect(normalize(fmtHour(0, "en-US"))).toBe("12 AM");
    expect(normalize(fmtHour(23, "en-US"))).toBe("11 PM");
  });

  it("defaults to the host locale", () => {
    expect(fmtHour(9)).toBe(fmtHour(9, undefined));
  });
});

describe(fmtDay, () => {
  it("names the current local day rather than dating it", () => {
    const clock = useFakeClock("2026-03-08T12:00:00.000Z");
    expect(clock.now()).toBe(Date.parse("2026-03-08T12:00:00.000Z"));
    expect(fmtDay(localDayKey(new Date()))).toBe("Today");
    const yesterday = localDayKey(new Date(clock.now() - 24 * 60 * 60 * 1000));
    expect(fmtDay(yesterday, "en-US")).not.toBe("Today");
  });

  it.each([
    ["en-US", "Sunday, Mar 8"],
    ["en-GB", "Sunday 8 Mar"],
  ] as const)("dates a day in %s as %s", (locale, expected) => {
    const clock = useFakeClock("2026-06-15T12:00:00.000Z");
    expect(clock.now()).toBeGreaterThan(0);
    expect(normalize(fmtDay("2026-03-08", locale))).toBe(expected);
  });

  it("reaches the locale for non-English calendars too", () => {
    const clock = useFakeClock("2026-06-15T12:00:00.000Z");
    expect(clock.now()).toBeGreaterThan(0);
    // Never pin whole non-English strings — an ICU upgrade turns them red.
    expect(normalize(fmtDay("2026-03-08", "de-DE"))).toContain("Sonntag");
    expect(normalize(fmtDay("2026-03-08", "de-DE"))).toContain("März");
    expect(normalize(fmtDay("2026-03-08", "ja-JP"))).toContain("3月8日");
    const readings = new Set(
      (["en-US", "en-GB", "de-DE", "ja-JP"] as const).map((locale) =>
        normalize(fmtDay("2026-03-08", locale))
      )
    );
    expect(readings.size).toBe(4);
  });

  it("returns the key unchanged when the locale is unusable", () => {
    const clock = useFakeClock("2026-06-15T12:00:00.000Z");
    expect(clock.now()).toBeGreaterThan(0);
    expect(fmtDay("2026-03-08", "not a locale")).toBe("2026-03-08");
  });

  it("defaults to the host locale", () => {
    const clock = useFakeClock("2026-06-15T12:00:00.000Z");
    expect(clock.now()).toBeGreaterThan(0);
    expect(fmtDay("2026-03-08")).toBe(fmtDay("2026-03-08", undefined));
  });
});

describe(rangeLabel, () => {
  it("labels a Monday-first week by its own two ends", () => {
    expect(startOfWeek(AFTERNOON).getDate()).toBe(2);
    expect(normalize(rangeLabel("week", AFTERNOON, "en-US"))).toBe(
      "Mar 2 – Mar 8, 2026"
    );
    expect(normalize(rangeLabel("week", AFTERNOON, "en-GB"))).toBe(
      "2 Mar – 8 Mar 2026"
    );
  });

  it("labels a day and a month at their own granularity", () => {
    expect(normalize(rangeLabel("day", AFTERNOON, "en-US"))).toBe(
      "Sunday, March 8"
    );
    expect(normalize(rangeLabel("day", AFTERNOON, "en-GB"))).toBe(
      "Sunday 8 March"
    );
    expect(normalize(rangeLabel("month", AFTERNOON, "en-US"))).toBe(
      "March 2026"
    );
    expect(normalize(rangeLabel("agenda", AFTERNOON, "en-US"))).toBe(
      "March 2026"
    );
  });

  it("keeps a week label that spans two months and a year boundary readable", () => {
    // ISO week 53 crosses the year; an anchor-month label renders it wrong.
    const weekFiftyThree = new Date(2026, 11, 28, 9, 0);
    expect(startOfWeek(weekFiftyThree).getDate()).toBe(28);
    expect(normalize(rangeLabel("week", weekFiftyThree, "en-US"))).toBe(
      "Dec 28 – Jan 3, 2027"
    );
  });

  it("defaults to the host locale", () => {
    expect(rangeLabel("week", AFTERNOON)).toBe(
      rangeLabel("week", AFTERNOON, undefined)
    );
    expect(rangeLabel("month", AFTERNOON)).toBe(
      rangeLabel("month", AFTERNOON, undefined)
    );
  });
});

describe(eventBounds, () => {
  it("sends the viewer's zone so a weekly series keeps wall-clock time across DST", () => {
    const bounds = eventBounds("2026-03-08T09:00", "2026-03-08T10:00", false);
    expect(bounds.start_tz).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
    expect(bounds.recurrence_semantics).toBe("zoned");
    expect(bounds.dtstart).toBe(toIsoUtc("2026-03-08T09:00"));
  });

  it("stores an all-day event as the civil date it names", () => {
    const bounds = eventBounds("2026-11-15T00:00", "2026-11-15T23:59", true);
    expect(bounds.dtstart).toBe("2026-11-15");
    expect(bounds.dtend).toBe("2026-11-15");
    expect(bounds.recurrence_semantics).toBe("all-day");
    expect(toLocalInput("2026-11-15").slice(0, 10)).toBe("2026-11-15");
  });
});

describe("Metro reachability", () => {
  it("does not import the DOM-only elements subpath", () => {
    // The phone's day list imports this file. `@centraid/design/elements` has
    // no `react-native` condition and resolves only through `dist/`, which
    // mobile-smoke never builds.
    const source = readFileSync(
      fileURLToPath(new URL("format.ts", import.meta.url)),
      "utf8"
    );
    expect(source).not.toMatch(/from\s+"@centraid\/design\/elements"/u);
    expect(source).toMatch(/from\s+"@centraid\/design"/u);
  });
});
