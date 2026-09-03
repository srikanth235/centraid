import { describe, expect, it } from "vitest";

import { collapseMissedOccurrences } from "./recurrence-collapse.js";
import { describeRecurrence } from "./recurrence-summary.js";
import {
  applyRecurrenceExceptions,
  expandRecurrence,
  nextOccurrence,
} from "./recurrence.js";

describe("canonicalizeRrule", () => {
  it("strips a Google/ICS RRULE: prefix so parsers share one bare form", async () => {
    const { canonicalizeRrule, parseRrule, rruleLine } =
      await import("./rrule-support.js");
    expect(canonicalizeRrule("RRULE:FREQ=WEEKLY;BYDAY=MO")).toBe(
      "FREQ=WEEKLY;BYDAY=MO"
    );
    expect(parseRrule("RRULE:FREQ=DAILY;COUNT=3")).toMatchObject({
      freq: "DAILY",
      count: 3,
    });
    expect(rruleLine("FREQ=MONTHLY")).toBe("RRULE:FREQ=MONTHLY");
    expect(rruleLine("RRULE:FREQ=MONTHLY")).toBe("RRULE:FREQ=MONTHLY");
  });
});

describe(expandRecurrence, () => {
  it("materializes a multi-year monthly series near the requested window", () => {
    const instances = expandRecurrence({
      rrule: "FREQ=MONTHLY",
      start: "2022-01-05",
      rangeFrom: "2026-03-05",
      rangeTo: "2026-03-06",
      semantics: "all-day",
      maxInstances: 2,
    });
    expect(instances.map((instance) => instance.start)).toStrictEqual([
      "2026-03-05",
    ]);
  });

  it("preserves floating wall clocks under a future-scope override", () => {
    const instances = expandRecurrence({
      rrule: "FREQ=DAILY;COUNT=4",
      start: "2026-07-01",
      rangeFrom: "2026-07-01",
      rangeTo: "2026-07-10",
      semantics: "all-day",
      maxInstances: 10,
    });
    const adjusted = applyRecurrenceExceptions(instances, [
      {
        originalStart: "2026-07-02",
        action: "override",
        scope: "future",
        start: "2026-07-03",
      },
    ]);
    expect(adjusted.map((instance) => instance.start)).toStrictEqual([
      "2026-07-01",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
    ]);
  });

  it("preserves a Kolkata wall time while other regions enter DST", () => {
    const instances = expandRecurrence({
      rrule: "FREQ=WEEKLY;COUNT=4",
      start: "2026-10-20T03:30:00.000Z",
      rangeFrom: "2026-10-01T00:00:00.000Z",
      rangeTo: "2026-12-01T00:00:00.000Z",
      timeZone: "Asia/Kolkata",
    });

    expect(instances.map((instance) => instance.wallStart)).toStrictEqual([
      "2026-10-20T09:00:00",
      "2026-10-27T09:00:00",
      "2026-11-03T09:00:00",
      "2026-11-10T09:00:00",
    ]);
  });

  it("skips a spring-forward gap", () => {
    const instances = expandRecurrence({
      rrule: "FREQ=DAILY;COUNT=3",
      start: "2026-03-07T07:30:00.000Z",
      rangeFrom: "2026-03-07T00:00:00.000Z",
      rangeTo: "2026-03-12T00:00:00.000Z",
      timeZone: "America/New_York",
    });

    expect(instances.map((instance) => instance.wallStart)).toStrictEqual([
      "2026-03-07T02:30:00",
      "2026-03-09T02:30:00",
      "2026-03-10T02:30:00",
    ]);
  });

  it("emits a fall-back overlap once at the earlier instant", () => {
    const instances = expandRecurrence({
      rrule: "FREQ=DAILY;COUNT=3",
      start: "2026-10-31T05:30:00.000Z",
      rangeFrom: "2026-10-31T00:00:00.000Z",
      rangeTo: "2026-11-04T00:00:00.000Z",
      timeZone: "America/New_York",
    });

    expect(instances[1]).toMatchObject({
      start: "2026-11-01T05:30:00.000Z",
      wallStart: "2026-11-01T01:30:00",
      overlap: true,
    });
    expect(instances).toHaveLength(3);
  });
});

describe("recurrence lifecycle", () => {
  it("supports completion-relative task cadence", () => {
    expect(
      nextOccurrence({
        rrule: "FREQ=DAILY",
        scheduledStart: "2026-07-01T09:00:00.000Z",
        after: "2026-07-05T12:00:00.000Z",
        timeZone: "Asia/Kolkata",
        anchor: "completion",
      })
    ).toBe("2026-07-06T12:00:00.000Z");
  });

  it("applies instance skips and overrides without changing identity", () => {
    const instances = expandRecurrence({
      rrule: "FREQ=DAILY;COUNT=3",
      start: "2026-07-01T09:00:00.000Z",
      rangeFrom: "2026-07-01T00:00:00.000Z",
      rangeTo: "2026-07-10T00:00:00.000Z",
      timeZone: "Etc/UTC",
    });
    const adjusted = applyRecurrenceExceptions(instances, [
      { originalStart: "2026-07-02T09:00:00.000Z", action: "skip" },
      {
        originalStart: "2026-07-03T09:00:00.000Z",
        action: "override",
        start: "2026-07-03T11:00:00.000Z",
      },
    ]);

    expect(adjusted.map((instance) => instance.start)).toStrictEqual([
      "2026-07-01T09:00:00.000Z",
      "2026-07-03T11:00:00.000Z",
    ]);
    expect(adjusted[1]?.originalStart).toBe("2026-07-03T09:00:00.000Z");
  });

  it("provides a readable preview", () => {
    expect(
      describeRecurrence("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6")
    ).toBe("Every other week on Monday and Wednesday · 6 times");
  });
});

describe(describeRecurrence, () => {
  // One summariser, one register: every surface renders these exact phrases.
  it.each([
    ["FREQ=DAILY", "Daily"],
    ["FREQ=DAILY;INTERVAL=2", "Every other day"],
    ["FREQ=DAILY;INTERVAL=5", "Every 5 days"],
    ["FREQ=WEEKLY", "Weekly"],
    ["FREQ=WEEKLY;BYDAY=MO", "Every Monday"],
    ["FREQ=WEEKLY;BYDAY=MO,TU", "Every Monday and Tuesday"],
    ["FREQ=WEEKLY;BYDAY=MO,WE,FR", "Every Monday, Wednesday and Friday"],
    ["FREQ=WEEKLY;INTERVAL=2;BYDAY=FR", "Every other Friday"],
    ["FREQ=WEEKLY;INTERVAL=2", "Every other week"],
    [
      "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,TU",
      "Every 3 weeks on Monday and Tuesday",
    ],
    ["FREQ=MONTHLY", "Every month"],
    ["FREQ=MONTHLY;INTERVAL=2", "Every other month"],
    ["FREQ=YEARLY", "Every year"],
    ["FREQ=YEARLY;INTERVAL=4", "Every 4 years"],
    ["FREQ=WEEKLY;BYDAY=TH;COUNT=5", "Every Thursday · 5 times"],
    ["FREQ=WEEKLY;BYDAY=TH;COUNT=1", "Every Thursday · once"],
    ["FREQ=DAILY;UNTIL=20260905T000000Z", "Daily · until Sep 5, 2026"],
    // An unparseable UNTIL drops the tail rather than leaking the rule text.
    ["FREQ=DAILY;UNTIL=SOON", "Daily"],
  ])("summarises %s as %s", (rrule, expected) => {
    expect(describeRecurrence(rrule)).toBe(expected);
  });

  it.each([
    ["FREQ=HOURLY", "sub-daily frequencies are not expanded"],
    [
      "FREQ=MONTHLY;BYDAY=MO",
      "means every Monday IN the month, not 'every month'",
    ],
    ["FREQ=WEEKLY;BYDAY=-1FR", "a positional day is BYSETPOS by another name"],
    ["FREQ=WEEKLY;BYDAY=MO,XX", "a non-day token is not filtered away"],
  ])("summarises nothing for %s: %s", (rrule) => {
    expect(describeRecurrence(rrule)).toBeNull();
  });
});

describe(collapseMissedOccurrences, () => {
  it("collapses four missed weeks into one live occurrence", () => {
    expect(
      collapseMissedOccurrences({
        rrule: "FREQ=WEEKLY",
        scheduledStart: "2026-08-01T09:00:00.000Z",
        timeZone: "Etc/UTC",
        anchor: "scheduled",
        now: "2026-08-26T12:00:00.000Z",
      })
    ).toStrictEqual({ missed: 4, nextDue: "2026-08-29T09:00:00.000Z" });
  });

  it("counts nothing before the first due", () => {
    expect(
      collapseMissedOccurrences({
        rrule: "FREQ=WEEKLY",
        scheduledStart: "2026-08-01T09:00:00.000Z",
        anchor: "scheduled",
        now: "2026-07-30T12:00:00.000Z",
      })
    ).toStrictEqual({ missed: 0, nextDue: "2026-08-01T09:00:00.000Z" });
  });

  it("treats an occurrence landing exactly on now as live, not missed", () => {
    expect(
      collapseMissedOccurrences({
        rrule: "FREQ=DAILY",
        scheduledStart: "2026-08-01T09:00:00.000Z",
        anchor: "scheduled",
        now: "2026-08-03T09:00:00.000Z",
      })
    ).toStrictEqual({ missed: 2, nextDue: "2026-08-03T09:00:00.000Z" });
  });

  it("forgives periods already completed under a scheduled anchor", () => {
    expect(
      collapseMissedOccurrences({
        rrule: "FREQ=WEEKLY",
        scheduledStart: "2026-08-01T09:00:00.000Z",
        anchor: "scheduled",
        now: "2026-08-26T12:00:00.000Z",
        lastCompletedAt: "2026-08-15T09:00:00.000Z",
      })
    ).toStrictEqual({ missed: 1, nextDue: "2026-08-29T09:00:00.000Z" });
  });

  it("never stacks under a completion anchor, however long the lapse", () => {
    const overdue = collapseMissedOccurrences({
      rrule: "FREQ=WEEKLY",
      scheduledStart: "2026-08-01T09:00:00.000Z",
      anchor: "completion",
      now: "2027-08-26T12:00:00.000Z",
      lastCompletedAt: "2026-08-03T09:00:00.000Z",
    });
    expect(overdue).toStrictEqual({
      missed: 1,
      nextDue: "2026-08-10T09:00:00.000Z",
    });
    expect(
      collapseMissedOccurrences({
        rrule: "FREQ=WEEKLY",
        scheduledStart: "2026-08-01T09:00:00.000Z",
        anchor: "completion",
        now: "2026-08-05T12:00:00.000Z",
        lastCompletedAt: "2026-08-03T09:00:00.000Z",
      }).missed
    ).toBe(0);
  });

  it("keeps the original due live until a completion-anchored task is done", () => {
    expect(
      collapseMissedOccurrences({
        rrule: "FREQ=WEEKLY",
        scheduledStart: "2026-08-01T09:00:00.000Z",
        anchor: "completion",
        now: "2026-08-26T12:00:00.000Z",
      })
    ).toStrictEqual({ missed: 1, nextDue: "2026-08-01T09:00:00.000Z" });
  });

  it("stops at the COUNT bound instead of inventing a next due", () => {
    expect(
      collapseMissedOccurrences({
        rrule: "FREQ=WEEKLY;COUNT=2",
        scheduledStart: "2026-08-01T09:00:00.000Z",
        anchor: "scheduled",
        now: "2026-08-26T12:00:00.000Z",
      })
    ).toStrictEqual({ missed: 2, nextDue: null });
  });

  it("caps a pathological backlog rather than walking forever", () => {
    const collapsed = collapseMissedOccurrences({
      rrule: "FREQ=DAILY",
      scheduledStart: "1990-01-01T09:00:00.000Z",
      anchor: "scheduled",
      now: "2026-08-26T12:00:00.000Z",
    });
    expect(collapsed.missed).toBe(1000);
    expect(collapsed.nextDue).toBe("2026-08-27T09:00:00.000Z");
  });

  it("returns nothing for an unparseable rule or clock", () => {
    expect(
      collapseMissedOccurrences({
        rrule: "FREQ=HOURLY",
        scheduledStart: "2026-08-01T09:00:00.000Z",
        anchor: "scheduled",
        now: "2026-08-26T12:00:00.000Z",
      })
    ).toStrictEqual({ missed: 0, nextDue: null });
    expect(
      collapseMissedOccurrences({
        rrule: "FREQ=WEEKLY",
        scheduledStart: "2026-08-01T09:00:00.000Z",
        anchor: "scheduled",
        now: "not a time",
      })
    ).toStrictEqual({ missed: 0, nextDue: null });
  });
});
