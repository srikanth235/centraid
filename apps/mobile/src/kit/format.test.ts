// One formatter module (#1015, S8 — audit §3.13). Five date registers across
// nine surfaces collapse to Tasks', which is the only one that was designed
// rather than inherited, plus Docs' sub-hour grain for edit stamps.
import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatDateShort,
  formatDateTime,
  formatMonth,
  formatRelative,
  formatTime,
} from "./format";

const NOW = "2026-09-10T12:00:00.000Z";

describe(formatRelative, () => {
  it("says nothing about an absent or unreadable stamp", () => {
    expect(formatRelative(null, NOW)).toBe("");
    expect(formatRelative("", NOW)).toBe("");
    expect(formatRelative("banana", NOW)).toBe("");
    expect(formatRelative(NOW, "banana")).toBe("");
  });

  it("keeps Tasks' day register, in Tasks' own words", () => {
    expect(formatRelative("2026-09-10", NOW)).toBe("today");
    expect(formatRelative("2026-09-11", NOW)).toBe("tomorrow");
    expect(formatRelative("2026-09-09", NOW)).toBe("yesterday");
    expect(formatRelative("2026-09-05", NOW)).toBe("5 days ago");
    // Inside the coming week a weekday is more use than a count.
    expect(formatRelative("2026-09-13", NOW)).toBe("Sunday");
    expect(formatRelative("2026-10-04", NOW)).toBe("4 Oct");
  });

  it("goes finer than a day for a stamp inside the last hour", () => {
    expect(formatRelative("2026-09-10T11:59:40.000Z", NOW)).toBe("moments ago");
    expect(formatRelative("2026-09-10T11:59:00.000Z", NOW)).toBe(
      "1 minute ago"
    );
    expect(formatRelative("2026-09-10T11:48:00.000Z", NOW)).toBe(
      "12 minutes ago"
    );
  });

  it("counts hours only while the stamp is still today", () => {
    expect(formatRelative("2026-09-10T09:00:00.000Z", NOW)).toBe("3 hours ago");
    expect(formatRelative("2026-09-10T11:00:00.000Z", NOW)).toBe("1 hour ago");
  });

  // A future stamp gets the day register: nothing on this seat counts down to
  // something later today, and "in an hour" would be a register with one
  // caller.
  it("says today for something later today", () => {
    expect(formatRelative("2026-09-10T18:00:00.000Z", NOW)).toContain("today");
  });
});

describe(formatDateShort, () => {
  it("says nothing about an absent or unreadable stamp", () => {
    expect(formatDateShort(undefined, NOW)).toBe("");
    expect(formatDateShort("banana", NOW)).toBe("");
  });

  it("prints the year only when it is not the current one", () => {
    expect(formatDateShort("2026-09-04", NOW)).toBe("4 Sep");
    expect(formatDateShort("2025-09-04", NOW)).toBe("4 Sep 2025");
  });
});

describe(formatBytes, () => {
  it("is the seat's one byte register", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe(formatTime, () => {
  it("says nothing about an unreadable stamp", () => {
    expect(formatTime("banana")).toBe("");
  });

  it("carries hour and minute, and never a seconds field", () => {
    const said = formatTime(new Date("2026-09-10T17:00:00.000Z"));
    expect(said).not.toContain(":00:00");
    expect(said.split(":")).toHaveLength(2);
  });
});

describe(formatDateTime, () => {
  it("puts the day before the time, in the seat's two registers", () => {
    const at = new Date("2026-09-04T17:00:00.000Z");
    expect(formatDateTime(at, NOW)).toBe(
      `${formatDateShort(at.toISOString(), NOW)}, ${formatTime(at)}`
    );
  });
});

describe(formatMonth, () => {
  it("names the month, and the year only once it is not this one", () => {
    expect(formatMonth("2026-09-10T00:00:00.000Z", NOW)).toBe("September");
    expect(formatMonth("2027-01-10T00:00:00.000Z", NOW)).toBe("January 2027");
    expect(formatMonth("banana", NOW)).toBe("");
  });
});
