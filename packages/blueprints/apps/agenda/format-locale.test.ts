// Agenda's HOST-LOCALE surface (issue #839, gap G12).
//
// `format.ts` is the app's only text projection of a time, and until now it had
// no suite of its own — `stryker.agenda.config.mjs` says so in as many words
// ("no suite of its own yet — its callers are asserted through
// views/day-context"). What those callers assert is which day a thing lands on,
// never what the member READS, so the entire locale surface was unpinned: every
// formatter handed `undefined` as its locale and took whatever the host's ICU
// default happened to be.
//
// That default is not a cosmetic detail. It decides whether an event at 14:05
// reads "2:05 PM" or "14:05" — a twelve-hour locale and a twenty-four-hour one
// produce strings a member could misread by twelve hours. A suite that lets the
// runner pick the locale cannot see that, and green on a US-English CI box
// says nothing about a member in Dublin or Tokyo.
//
// So the formatters take an optional trailing `locale` (default `undefined` —
// byte-identical to the previous behaviour, no call site changed), and the
// tests below pin what each NAMED locale renders. The default path is pinned
// too, as equality with the explicit-`undefined` call, so the seam cannot drift
// away from the product behaviour it was carved out of.
//
// Dates are built from LOCAL components (`new Date(2026, 2, 8, 14, 5)`) rather
// than from `Z` instants: these formatters read the host zone, and a local
// constructor is the one way to write a wall-clock assertion that holds in
// every runner zone.

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

/**
 * ICU renders the space before a meridiem as U+202F (narrow no-break space) in
 * some versions and as U+0020 in others; the same is true of U+00A0 inside
 * European date forms. Normalising them keeps these pins about the LOCALE's
 * decisions — 12h vs 24h, field order, month name — instead of about which ICU
 * the runner shipped with.
 */
function normalize(value: string): string {
  return value.replace(/[  ]/gu, " ");
}

/** 2026-03-08 is a Sunday; 14:05 local exists in every zone (no transition). */
const AFTERNOON = new Date(2026, 2, 8, 14, 5);

describe(fmtTime, () => {
  it("renders a twelve-hour locale with a meridiem", () => {
    // The hazard the host-locale default hides: the SAME instant, two readings.
    expect(normalize(fmtTime(AFTERNOON, "en-US"))).toBe("2:05 PM");
  });

  it.each([["en-GB"], ["de-DE"], ["ja-JP"]] as const)(
    "renders %s on a twenty-four-hour clock with no meridiem",
    (locale) => {
      expect(normalize(fmtTime(AFTERNOON, locale))).toBe("14:05");
    }
  );

  it("pads the minute below ten but NOT the hour", () => {
    // `minute: "2-digit"` stops "9:5" reaching a member; `hour: "numeric"`
    // deliberately does not pad, so a 24-hour locale reads "9:05" here while
    // the grid rail (`fmtHour`, an hour-only skeleton) reads "09". The two
    // disagree by design and this pins that they do.
    const nineOhFive = new Date(2026, 2, 8, 9, 5);
    expect(normalize(fmtTime(nineOhFive, "en-US"))).toBe("9:05 AM");
    expect(normalize(fmtTime(nineOhFive, "en-GB"))).toBe("9:05");
    expect(normalize(fmtHour(9, "en-GB"))).toBe("09");
  });

  it("defaults to the host locale, unchanged by the injectable seam", () => {
    // The seam must be a pure widening: omitting the argument and passing
    // `undefined` are the same call, which is what makes every existing call
    // site untouched by construction.
    expect(fmtTime(AFTERNOON)).toBe(fmtTime(AFTERNOON, undefined));
  });

  it("falls back to the raw value when the locale itself is unusable", () => {
    // `toLocaleTimeString` throws RangeError on a malformed locale tag. A
    // calendar row must degrade to something rather than take the app down.
    expect(fmtTime("2026-03-08T14:05:00.000Z", "not a locale")).toBe(
      "2026-03-08T14:05:00.000Z"
    );
  });

  it("does not throw on an unparseable date", () => {
    // Invalid Date does not throw here — it formats. Pinned so the `catch`
    // above is understood to be the LOCALE guard, not the date guard.
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
    // The rail label is `hour: "numeric"` only, which four locales render four
    // different ways. A test that read the host default would assert one of
    // them and call it the contract.
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
    // Under a pinned clock so "Today" is a decision about the host's calendar
    // day and not about when CI happened to run.
    const clock = useFakeClock("2026-03-08T12:00:00.000Z");
    expect(clock.now()).toBe(Date.parse("2026-03-08T12:00:00.000Z"));
    expect(fmtDay(localDayKey(new Date()))).toBe("Today");
    // Any other day is dated. Yesterday is chosen relative to the frozen
    // clock so the assertion cannot accidentally be about "today" again.
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
    // Pinned by their locale-distinctive parts rather than whole strings: the
    // point is that the locale ARRIVED, and whole-string pins on non-English
    // forms turn an ICU upgrade into a false red.
    expect(normalize(fmtDay("2026-03-08", "de-DE"))).toContain("Sonntag");
    expect(normalize(fmtDay("2026-03-08", "de-DE"))).toContain("März");
    expect(normalize(fmtDay("2026-03-08", "ja-JP"))).toContain("3月8日");
    // Four locales, four distinct readings of one day — the divergence the
    // host-locale default was hiding.
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
    // 2026-03-08 is a Sunday, so the Monday-first week it belongs to opens on
    // 2026-03-02 and closes on the anchor itself. The year is printed once, on
    // the closing end.
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
    // Anything that is not "week" or "day" is the month heading — the default
    // branch, which is what the month grid actually uses.
    expect(normalize(rangeLabel("month", AFTERNOON, "en-US"))).toBe(
      "March 2026"
    );
    expect(normalize(rangeLabel("agenda", AFTERNOON, "en-US"))).toBe(
      "March 2026"
    );
  });

  it("keeps a week label that spans two months and a year boundary readable", () => {
    // The week of 2026-12-28 (ISO week 53) runs into January 2027 — the case a
    // label built from the anchor's month alone would render wrong.
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
