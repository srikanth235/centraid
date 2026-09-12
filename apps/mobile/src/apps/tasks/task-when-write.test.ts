// The field→`edit` mapping behind When, Time, Reminder and Repeats (#1015,
// audit tasks/findings#2). Before this slice all four rows rendered `null`,
// so no test could fail: this one falsifies the mapping, not the picker.

import { describe, expect, it } from "vitest";

import {
  dueDate,
  dueOf,
  localDay,
  localStamp,
  reminderWrite,
  repeatWrite,
  timeWrite,
  whenWrite,
} from "./task-when-write";

const TASK = { task_id: "t1" };

describe("a due stamp is local wall clock", () => {
  it("never round-trips through UTC", () => {
    // `timeOfDay` reads `value.slice(11, 16)`, so a `toISOString()` would move
    // the clock — and, near midnight, the civil day with it.
    const late = new Date(2026, 8, 10, 23, 30, 0, 0);
    expect(localDay(late)).toBe("2026-09-10");
    expect(localStamp(late)).toBe("2026-09-10T23:30");
  });

  it("opens the picker on the stored due, or on the fallback when undated", () => {
    const fallback = new Date(2026, 0, 1, 8, 0, 0, 0);
    expect(dueDate("2026-09-10T17:45", fallback).getHours()).toBe(17);
    expect(dueDate("2026-09-10", fallback).getHours()).toBe(0);
    expect(dueDate(null, fallback)).toStrictEqual(fallback);
    expect(dueDate("nonsense", fallback)).toStrictEqual(fallback);
  });

  it("reads the next occurrence ahead of the original due", () => {
    expect(dueOf({ due_at: "2026-09-01", next_due: "2026-09-08" })).toBe(
      "2026-09-08"
    );
    expect(dueOf({})).toBeNull();
  });
});

describe("when", () => {
  it("dates an undated task as a whole day", () => {
    expect(whenWrite(TASK, new Date(2026, 8, 14, 9, 0))).toStrictEqual({
      task_id: "t1",
      due_at: "2026-09-14",
    });
  });

  it("KEEPS THE TIME when the day moves", () => {
    // Moving a Friday 09:00 task to Monday must not silently drop 09:00.
    expect(
      whenWrite(
        { ...TASK, due_at: "2026-09-11T09:00" },
        new Date(2026, 8, 14, 0, 0)
      )
    ).toStrictEqual({ task_id: "t1", due_at: "2026-09-14T09:00" });
  });

  it("clears the date rather than writing an empty one", () => {
    expect(whenWrite({ ...TASK, due_at: "2026-09-11" }, null)).toStrictEqual({
      task_id: "t1",
      clear_due: true,
    });
  });
});

describe("time", () => {
  it("puts a moment on the day the task already has", () => {
    expect(
      timeWrite(
        { ...TASK, due_at: "2026-09-11" },
        new Date(2026, 0, 1, 17, 45),
        new Date(2026, 8, 10)
      )
    ).toStrictEqual({ task_id: "t1", due_at: "2026-09-11T17:45" });
  });

  it("dates an undated task today rather than refusing in silence", () => {
    expect(
      timeWrite(TASK, new Date(2026, 0, 1, 7, 5), new Date(2026, 8, 10))
    ).toStrictEqual({ task_id: "t1", due_at: "2026-09-10T07:05" });
  });

  it("drops the moment back to a whole day when the time is cleared", () => {
    expect(
      timeWrite(
        { ...TASK, due_at: "2026-09-11T17:45" },
        null,
        new Date(2026, 8, 10)
      )
    ).toStrictEqual({ task_id: "t1", due_at: "2026-09-11" });
  });
});

describe("reminder and repeats", () => {
  it("distinguishes no lead from a zero lead", () => {
    expect(reminderWrite(TASK, null)).toStrictEqual({
      task_id: "t1",
      clear_remind: true,
    });
    expect(reminderWrite(TASK, 0)).toStrictEqual({
      task_id: "t1",
      remind_before_min: 0,
    });
  });

  it("clears a rule rather than writing an empty one", () => {
    expect(repeatWrite(TASK, "FREQ=WEEKLY")).toStrictEqual({
      task_id: "t1",
      rrule: "FREQ=WEEKLY",
    });
    expect(repeatWrite(TASK, null)).toStrictEqual({
      task_id: "t1",
      clear_rrule: true,
    });
  });
});
