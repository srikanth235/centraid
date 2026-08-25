/**
 * WHEN a task is (#834). Import-free so Home and the phone can both read it.
 * `format.ts` and `logic.ts` re-export from here — one definition of
 * `landsToday`. An undated task never touches Today.
 */

export function dayKey(value: string): string {
  return value.slice(0, 10);
}

export function isDateOnly(due: string | null | undefined): boolean {
  return typeof due === "string" && !due.includes("T");
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${dayKey(from)}T00:00:00Z`);
  const b = Date.parse(`${dayKey(to)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function weekdayName(value: string): string {
  const parsed = new Date(`${dayKey(value)}T00:00:00Z`);
  return WEEKDAYS[parsed.getUTCDay()] ?? "";
}

export function monthName(value: string): string {
  const index = Number(value.slice(5, 7)) - 1;
  return MONTHS[index] ?? "";
}

export function timeOfDay(value: string): string {
  return value.slice(11, 16);
}

export function dueLabel(
  due: string | null | undefined,
  now: string
): string | null {
  if (!due) return null;
  const delta = daysBetween(now, due);
  const clock = isDateOnly(due) ? "" : `, ${timeOfDay(due)}`;
  if (delta === 0) return `today${clock}`;
  if (delta === 1) return `tomorrow${clock}`;
  if (delta === -1) return `yesterday${clock}`;
  if (delta < 0) return `${Math.abs(delta)} days ago`;
  if (delta <= 6) return `${weekdayName(due)}${clock}`;
  return `${Number(due.slice(8, 10))} ${monthName(due).slice(0, 3)}${clock}`;
}

export interface TaskWhen {
  due_at?: string | null;
  next_due?: string | null;
}

export function landsToday(task: TaskWhen, now: string): boolean {
  const due = task.next_due ?? task.due_at;
  if (!due) return false;
  return daysBetween(now, due) <= 0;
}

export function isOverdueWhen(task: TaskWhen, now: string): boolean {
  const due = task.next_due ?? task.due_at;
  if (!due) return false;
  return daysBetween(now, due) < 0;
}
