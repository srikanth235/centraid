import { describe, expect, it } from "vitest";

import {
  leadLabel,
  monthDayOf,
  nextOccurrence,
  planBirthdayNotifications,
} from "./birthday-notifications";
import type { BirthdayPerson } from "./birthday-notifications";
import { notificationActionPlan } from "./notification-model";

/** Sunday 1 March 2026, 08:00 local. */
const NOW = new Date(2026, 2, 1, 8, 0);

const DANA: BirthdayPerson = {
  partyId: "p-dana",
  name: "Dana Okafor",
  birthDate: "1988-03-12",
  inner: true,
};
const RUTH: BirthdayPerson = {
  partyId: "p-ruth",
  name: "Ruth Vance",
  birthDate: "--03-19",
  inner: false,
};

describe("reading a birth date", () => {
  it("takes the recurring MM-DD from both stored forms", () => {
    expect(monthDayOf("1988-03-12")).toBe("03-12");
    expect(monthDayOf("--03-19")).toBe("03-19");
    expect(monthDayOf("")).toBeNull();
    expect(monthDayOf("sometime")).toBeNull();
  });

  it("finds the next occurrence, rolling into next year once past", () => {
    expect(nextOccurrence("03-12", NOW)?.toDateString()).toBe(
      new Date(2026, 2, 12).toDateString()
    );
    expect(nextOccurrence("02-14", NOW)?.toDateString()).toBe(
      new Date(2027, 1, 14).toDateString()
    );
  });

  it("leaves a 29 February birthday absent rather than rounding it", () => {
    // Neither 2026 nor 2027 has one, and 1 March is somebody else's day.
    expect(nextOccurrence("02-29", NOW)).toBeNull();
  });
});

describe(planBirthdayNotifications, () => {
  it("notifies the inner circle at the member's lead", () => {
    const plan = planBirthdayNotifications({
      people: [DANA, RUTH],
      leadDays: 2,
      now: NOW,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]?.partyId).toBe("p-dana");
    expect(plan[0]?.title).toBe("Dana Okafor’s birthday is on Thursday");
    expect(plan[0]?.body).toBe(
      "Inner circle · your phone tells you 2 days ahead."
    );
    // Two days ahead of the 12th, at the hour a member can act on it.
    expect(plan[0]?.at.toISOString()).toBe(
      new Date(2026, 2, 10, 9).toISOString()
    );
    expect(plan[0]?.url).toBe("centraid://apps/people/p-dana");
  });

  /** NEVER FOR ANYONE BUT THE INNER CIRCLE. Everyone else stays a ribbon. */
  it("never notifies for someone the owner has not starred", () => {
    const plan = planBirthdayNotifications({
      people: [{ ...RUTH, inner: false }],
      now: NOW,
    });
    expect(plan).toStrictEqual([]);
  });

  it("moves with the lead the member chose", () => {
    const sameDay = planBirthdayNotifications({
      people: [DANA],
      leadDays: 0,
      now: NOW,
    });
    expect(sameDay[0]?.at.toISOString()).toBe(
      new Date(2026, 2, 12, 9).toISOString()
    );
    const week = planBirthdayNotifications({
      people: [DANA],
      leadDays: 7,
      now: NOW,
    });
    expect(week[0]?.at.toISOString()).toBe(
      new Date(2026, 2, 5, 9).toISOString()
    );
    expect(week[0]?.body).toBe(
      "Inner circle · your phone tells you 1 week ahead."
    );
  });

  it("drops a lead that has already passed rather than firing it late", () => {
    // Two days before the 12th is the 10th; asking on the 11th is too late.
    const plan = planBirthdayNotifications({
      people: [DANA],
      leadDays: 2,
      now: new Date(2026, 2, 11, 8),
    });
    expect(plan).toStrictEqual([]);
  });

  it("schedules a person's year exactly once", () => {
    const first = planBirthdayNotifications({
      people: [DANA],
      leadDays: 2,
      now: NOW,
    });
    const again = planBirthdayNotifications({
      people: [DANA],
      leadDays: 2,
      now: NOW,
      delivered: new Set(first.map((row) => row.key)),
    });
    expect(again).toStrictEqual([]);
  });

  it("uses the default lead when the member has chosen none", () => {
    expect(
      planBirthdayNotifications({ people: [DANA], now: NOW })[0]?.body
    ).toBe("Inner circle · your phone tells you 2 days ahead.");
    expect(leadLabel(2)).toBe("2 days");
  });
});

describe("the tap", () => {
  it("lands on the person, never on the calendar", () => {
    expect(
      notificationActionPlan("OPEN_ITEM", {
        kind: "birthday",
        partyId: "p-dana",
      })
    ).toStrictEqual({ kind: "open-person", partyId: "p-dana" });
  });
});
