import { describe, expect, it } from "vitest";

import { classifyTemporal, isTemporal, temporalRefusal } from "./temporal.js";

describe(classifyTemporal, () => {
  it("reads an instant, a floating wall clock, a date and a month-day", () => {
    expect(classifyTemporal("2026-03-01T09:00:00Z")).toBe("instant");
    expect(classifyTemporal("2026-03-01T09:00:00+05:30")).toBe("instant");
    expect(classifyTemporal("2026-03-01T09:00")).toBe("floating-datetime");
    expect(classifyTemporal("2026-03-01T09:00:00.123456789")).toBe(
      "floating-datetime"
    );
    expect(classifyTemporal("2026-03-01")).toBe("local-date");
    expect(classifyTemporal("02-29")).toBe("month-day");
    expect(classifyTemporal("12-31")).toBe("month-day");
  });

  it("refuses February 31 in every reading that has a year, and a non-leap 29th", () => {
    expect(classifyTemporal("2026-02-31T09:00:00Z")).toBeNull();
    expect(classifyTemporal("2026-02-31")).toBeNull();
    expect(classifyTemporal("2027-02-29")).toBeNull();
    expect(classifyTemporal("2024-02-29")).toBe("local-date");
    expect(classifyTemporal("02-31")).toBeNull();
    expect(classifyTemporal("00-10")).toBeNull();
    expect(classifyTemporal("13-01")).toBeNull();
  });

  it("refuses a clock that is not a clock", () => {
    expect(classifyTemporal("2026-03-01T24:00:00Z")).toBeNull();
    expect(classifyTemporal("2026-03-01T09:60")).toBeNull();
    expect(classifyTemporal("banana")).toBeNull();
    expect(classifyTemporal("2026-03-01 09:00")).toBeNull();
  });
});

describe(isTemporal, () => {
  it("accepts only the kinds the field named", () => {
    expect(isTemporal("2026-03-01T09:00:00Z", ["instant"])).toBe(true);
    expect(isTemporal("2026-03-01T09:00:00Z", ["local-date"])).toBe(false);
    expect(isTemporal("banana", ["instant", "local-date"])).toBe(false);
  });
});

describe(temporalRefusal, () => {
  it("says what arrived and what the field takes", () => {
    expect(temporalRefusal("due_at", "banana", ["instant"])).toContain(
      "due_at"
    );
    expect(temporalRefusal("due_at", "banana", ["instant"])).toContain(
      "banana"
    );
    expect(temporalRefusal("due_at", "banana", ["instant"])).toContain(
      "an instant"
    );
  });
});
