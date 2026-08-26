import { describe, expect, it } from "vitest";

import { daysSpannedByEvent, groupEventsByLocalDay } from "./agenda-days";

function at(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0
): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

describe(daysSpannedByEvent, () => {
  it("keeps a MULTI-DAY run visible on every local day it spans", () => {
    expect(
      daysSpannedByEvent({
        start: at(2026, 8, 21, 22),
        end: at(2026, 8, 23, 9),
      })
    ).toStrictEqual(["2026-08-21", "2026-08-22", "2026-08-23"]);
  });

  it("keeps an all-day run on every civil day the member named, end inclusive", () => {
    expect(
      daysSpannedByEvent({
        start: "2026-08-21",
        end: "2026-08-23",
        recurrenceSemantics: "all-day",
      })
    ).toStrictEqual(["2026-08-21", "2026-08-22", "2026-08-23"]);
  });

  it("does not invent a day for a same-day timed event", () => {
    expect(
      daysSpannedByEvent({
        start: at(2026, 8, 21, 9),
        end: at(2026, 8, 21, 10),
      })
    ).toStrictEqual(["2026-08-21"]);
  });

  it("drops a row whose start the vault could not parse rather than guessing", () => {
    expect(daysSpannedByEvent({ start: "not a date" })).toStrictEqual([]);
  });
});

describe(groupEventsByLocalDay, () => {
  it("places one occurrence onto each occupied day, not only the start day", () => {
    const trip = {
      id: "trip",
      start: at(2026, 8, 21, 22),
      end: at(2026, 8, 23, 9),
    };
    const grouped = groupEventsByLocalDay([trip]);
    expect(grouped.map((day) => day.key)).toStrictEqual([
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
    ]);
    expect(grouped.every((day) => day.events[0]?.id === "trip")).toBe(true);
  });
});
