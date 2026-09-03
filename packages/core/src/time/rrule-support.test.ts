import { describe, expect, it, test } from "vitest";

import { describeRecurrence } from "./recurrence-summary.js";
import { expandRecurrence } from "./recurrence.js";
import {
  assertSupportedRrule,
  inspectRrule,
  parseRrule,
  rruleRefusalMessage,
  UnsupportedRruleError,
} from "./rrule-support.js";

const REFUSED_PARTS = [
  ["BYSETPOS", "FREQ=MONTHLY;BYSETPOS=-1"],
  ["BYMONTHDAY", "FREQ=MONTHLY;BYMONTHDAY=1"],
  ["BYMONTH", "FREQ=YEARLY;BYMONTH=3"],
  ["BYYEARDAY", "FREQ=YEARLY;BYYEARDAY=200"],
  ["BYWEEKNO", "FREQ=YEARLY;BYWEEKNO=12"],
  ["BYHOUR", "FREQ=DAILY;BYHOUR=9"],
  ["BYMINUTE", "FREQ=DAILY;BYMINUTE=30"],
  ["BYSECOND", "FREQ=DAILY;BYSECOND=15"],
] as const;

describe("inspectRrule refuses what the expander cannot honour", () => {
  test.each(REFUSED_PARTS)("%s is refused by name", (part, rrule) => {
    const support = inspectRrule(rrule);
    expect(support).toStrictEqual({
      ok: false,
      reason: "unsupported-part",
      part,
    });
    expect(parseRrule(rrule)).toBeNull();
    expect(describeRecurrence(rrule)).toBeNull();
    expect(
      expandRecurrence({
        rrule,
        start: "2026-01-05",
        rangeFrom: "2026-01-01",
        rangeTo: "2027-01-01",
        semantics: "all-day",
      })
    ).toStrictEqual([]);
  });

  test.each(["HOURLY", "MINUTELY", "SECONDLY"])(
    "FREQ=%s is refused as a frequency, not read as malformed",
    (freq) => {
      expect(inspectRrule(`FREQ=${freq};INTERVAL=2`)).toStrictEqual({
        ok: false,
        reason: "unsupported-freq",
        freq,
      });
    }
  );

  test.each(["", "garbage", "INTERVAL=2", "FREQ=", "FREQ=FORTNIGHTLY"])(
    "a rule with no usable FREQ (%s) is malformed, never defaulted",
    (rrule) => {
      expect(inspectRrule(rrule)).toStrictEqual({
        ok: false,
        reason: "malformed",
      });
    }
  );

  it("refuses a lowercase or RRULE:-prefixed part too — canonicalization runs first", () => {
    expect(inspectRrule("RRULE:freq=monthly;bysetpos=-1")).toStrictEqual({
      ok: false,
      reason: "unsupported-part",
      part: "BYSETPOS",
    });
  });
});

describe("BYDAY is honoured only where the expander reads it", () => {
  it.each(["DAILY", "MONTHLY", "YEARLY"])(
    "refuses BYDAY on FREQ=%s, which names a rule this engine cannot expand",
    (freq) => {
      expect(inspectRrule(`FREQ=${freq};BYDAY=MO`)).toStrictEqual({
        ok: false,
        reason: "unsupported-part",
        part: "BYDAY",
      });
    }
  );

  it.each(["1MO", "-1FR", "+2WE"])(
    "refuses the positional member %s rather than filtering it out",
    (token) => {
      expect(inspectRrule(`FREQ=WEEKLY;BYDAY=MO,${token}`)).toStrictEqual({
        ok: false,
        reason: "unsupported-part",
        part: "BYDAY",
      });
    }
  );

  it.each(["XX", ""])("treats the non-day token %s as malformed", (token) => {
    expect(inspectRrule(`FREQ=WEEKLY;BYDAY=MO,${token}`)).toStrictEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("still reads a clean day list in rule order", () => {
    expect(inspectRrule("FREQ=WEEKLY;BYDAY=FR,MO")).toStrictEqual({
      ok: true,
      rule: { freq: "WEEKLY", interval: 1, byDay: ["FR", "MO"] },
    });
  });
});

describe("WKST", () => {
  it("is refused above INTERVAL=1, where it would move the whole series", () => {
    expect(
      inspectRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=MO")
    ).toStrictEqual({ ok: false, reason: "unsupported-part", part: "WKST" });
  });

  it("is accepted at INTERVAL=1, where every week start agrees", () => {
    const support = inspectRrule("FREQ=WEEKLY;BYDAY=MO;WKST=MO");
    expect(support).toStrictEqual({
      ok: true,
      rule: { freq: "WEEKLY", interval: 1, byDay: ["MO"] },
    });
  });

  it("is accepted at any interval when it names the engine's own week start", () => {
    expect(inspectRrule("FREQ=WEEKLY;INTERVAL=3;WKST=SU").ok).toBe(true);
  });
});

describe("supported rules are unchanged", () => {
  it.each([
    ["FREQ=DAILY", { freq: "DAILY", interval: 1 }],
    ["FREQ=DAILY;INTERVAL=3", { freq: "DAILY", interval: 3 }],
    [
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5",
      { freq: "WEEKLY", interval: 2, count: 5, byDay: ["MO", "WE"] },
    ],
    [
      "FREQ=YEARLY;UNTIL=20301231T000000Z",
      { freq: "YEARLY", interval: 1, until: "20301231T000000Z" },
    ],
  ])("%s parses byte-for-byte as before", (rrule, expected) => {
    expect(parseRrule(rrule)).toStrictEqual(expected);
  });
});

describe(assertSupportedRrule, () => {
  it("returns the rule when the engine can honour it", () => {
    expect(assertSupportedRrule("RRULE:FREQ=DAILY;COUNT=3")).toStrictEqual({
      freq: "DAILY",
      interval: 1,
      count: 3,
    });
  });

  it("throws a typed refusal a write boundary can render", () => {
    let caught: unknown;
    try {
      assertSupportedRrule("FREQ=MONTHLY;BYSETPOS=-1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedRruleError);
    const error = caught as UnsupportedRruleError;
    expect(error.refusal).toStrictEqual({
      ok: false,
      reason: "unsupported-part",
      part: "BYSETPOS",
    });
    expect(error.message).toContain("BYSETPOS");
    expect(error.message).toContain("FREQ=MONTHLY;BYSETPOS=-1");
  });
});

describe(rruleRefusalMessage, () => {
  it("names the part, the frequency, or the missing FREQ", () => {
    expect(
      rruleRefusalMessage({
        ok: false,
        reason: "unsupported-part",
        part: "BYMONTHDAY",
      })
    ).toContain("BYMONTHDAY");
    expect(
      rruleRefusalMessage({
        ok: false,
        reason: "unsupported-freq",
        freq: "HOURLY",
      })
    ).toContain("HOURLY");
    expect(rruleRefusalMessage({ ok: false, reason: "malformed" })).toContain(
      "FREQ"
    );
    expect(
      rruleRefusalMessage({
        ok: false,
        reason: "unsupported-part",
        part: "WKST",
      })
    ).toContain("Sunday");
    expect(
      rruleRefusalMessage({
        ok: false,
        reason: "unsupported-part",
        part: "BYDAY",
      })
    ).toContain("WEEKLY");
  });
});
