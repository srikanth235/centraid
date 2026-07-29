import { describe, expect, it } from "vitest";

import {
  applyRecurrenceExceptions,
  describeRecurrence,
  expandRecurrence,
  nextOccurrence,
} from "./recurrence.js";

describe(expandRecurrence, () => {
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
    ).toBe("Every 2 weeks on MO, WE, 6 times");
  });
});
