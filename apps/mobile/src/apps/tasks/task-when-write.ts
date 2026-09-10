// The writes behind the detail place's When, Time, Reminder and Repeats
// fields (#1015, audit tasks/findings#2, blocker).
//
// The four fields drew a value and up to two explanatory notes and NO control:
// `FieldControl` fell through to `null` for every one of them. Dating a task
// was only possible at creation time or through "Move all to today", so there
// was no reschedule, no snooze, no clear-the-date and no reminder anywhere on
// this seat — under a Reminder field whose own note explains how reminders are
// delivered on your phone.
//
// The `edit` action always accepted all four (`app.json`: `due_at`/`clear_due`,
// `remind_before_min`/`clear_remind`, `rrule`/`clear_rrule`); only the seat was
// missing. These are the pure input builders, so the mapping is assertable
// without a picker.
//
// A due stamp is LOCAL WALL CLOCK, never UTC: `timeOfDay` reads it as
// `value.slice(11, 16)`, so a `toISOString()` round trip would move both the
// clock and, near midnight, the day.

import { isDateOnly } from "@centraid/blueprints/apps/tasks/when";

export type TaskEdit = Record<string, string | number | boolean>;

const pad = (value: number): string => String(value).padStart(2, "0");

/** `YYYY-MM-DD` in the seat's own civil day. */
export function localDay(when: Date): string {
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/** `YYYY-MM-DDTHH:MM` — the shape `timeOfDay` and `isDateOnly` already read. */
export function localStamp(when: Date): string {
  return `${localDay(when)}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

/** The due value a task currently carries, next occurrence first. */
export function dueOf(task: {
  due_at?: string | null;
  next_due?: string | null;
}): string | null {
  return task.next_due ?? task.due_at ?? null;
}

/** Reads a stored due back into a Date the native picker can open on. Falls
 *  back to `fallback` for an undated task, so the picker never opens on the
 *  epoch. */
export function dueDate(due: string | null, fallback: Date): Date {
  if (!due) return fallback;
  const year = Number(due.slice(0, 4));
  const month = Number(due.slice(5, 7));
  const day = Number(due.slice(8, 10));
  if (!year || !month || !day) return fallback;
  const hour = isDateOnly(due) ? 0 : Number(due.slice(11, 13));
  const minute = isDateOnly(due) ? 0 : Number(due.slice(14, 16));
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/** SETTING THE DAY KEEPS THE TIME. A task due Friday at 09:00 moved to Monday
 *  is still due at 09:00; picking a day is not a way to lose a moment. */
export function whenWrite(
  task: { task_id: string; due_at?: string | null; next_due?: string | null },
  day: Date | null
): TaskEdit {
  if (!day) return { task_id: task.task_id, clear_due: true };
  const due = dueOf(task);
  if (!due || isDateOnly(due)) {
    return { task_id: task.task_id, due_at: localDay(day) };
  }
  const kept = dueDate(due, day);
  const moved = new Date(day);
  moved.setHours(kept.getHours(), kept.getMinutes(), 0, 0);
  return { task_id: task.task_id, due_at: localStamp(moved) };
}

/** Setting a time on an undated task dates it TODAY: a moment with no day is
 *  not a thing the vault can store, and refusing silently is the defect this
 *  whole slice is about. */
export function timeWrite(
  task: { task_id: string; due_at?: string | null; next_due?: string | null },
  time: Date | null,
  today: Date
): TaskEdit {
  const due = dueOf(task);
  const day = dueDate(due, today);
  if (!time) return { task_id: task.task_id, due_at: localDay(day) };
  const moment = new Date(day);
  moment.setHours(time.getHours(), time.getMinutes(), 0, 0);
  return { task_id: task.task_id, due_at: localStamp(moment) };
}

export function reminderWrite(
  task: { task_id: string },
  minutesBefore: number | null
): TaskEdit {
  return minutesBefore === null
    ? { task_id: task.task_id, clear_remind: true }
    : { task_id: task.task_id, remind_before_min: minutesBefore };
}

export function repeatWrite(
  task: { task_id: string },
  rrule: string | null
): TaskEdit {
  return rrule === null
    ? { task_id: task.task_id, clear_rrule: true }
    : { task_id: task.task_id, rrule };
}
