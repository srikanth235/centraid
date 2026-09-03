import { describe, expect, it } from "vitest";

import { daysUntilMonthDay, isOverdue } from "./format.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 15, 12);

function iso(daysAgo: number): string {
  return new Date(NOW - daysAgo * DAY).toISOString();
}

describe("overdue arithmetic matches the cadence", () => {
  it("is not overdue on the cadence day — only after it", () => {
    const atCadence = {
      cadence_days: 30,
      last_contacted_at: iso(30),
      created_at: iso(90),
    };
    const pastCadence = {
      cadence_days: 30,
      last_contacted_at: iso(31),
      created_at: iso(90),
    };
    const stillInside = {
      cadence_days: 30,
      last_contacted_at: iso(29),
      created_at: iso(90),
    };
    expect(isOverdue(atCadence, NOW)).toBe(false);
    expect(isOverdue(pastCadence, NOW)).toBe(true);
    expect(isOverdue(stillInside, NOW)).toBe(false);
  });
});

describe("leap-day birthdays fire on 28 Feb in non-leap years", () => {
  it("lands on 28 Feb when 29 Feb does not exist", () => {
    const feb28 = new Date(2025, 1, 28).getTime();
    const feb27 = new Date(2025, 1, 27).getTime();
    const mar1 = new Date(2025, 2, 1).getTime();
    const feb28Next = new Date(2026, 1, 28).getTime();
    expect(daysUntilMonthDay("02-29", feb28)).toBe(0);
    expect(daysUntilMonthDay("02-29", feb27)).toBe(1);
    expect(daysUntilMonthDay("02-29", mar1)).toBe(
      Math.round((feb28Next - mar1) / DAY)
    );
  });

  it("keeps 29 Feb in a leap year", () => {
    const feb29 = new Date(2024, 1, 29).getTime();
    const feb28 = new Date(2024, 1, 28).getTime();
    expect(daysUntilMonthDay("02-29", feb29)).toBe(0);
    expect(daysUntilMonthDay("02-29", feb28)).toBe(1);
  });
});
