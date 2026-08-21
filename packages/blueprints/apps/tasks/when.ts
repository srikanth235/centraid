/**
 * WHEN a task is, as the whole house asks it — and the only place the answers
 * live (#834).
 *
 * Deliberately IMPORT-FREE, the same shape and for the same reason as
 * `apps/_shared/shared-copy.ts`: the shell's Home tile and the phone both read
 * these predicates, and neither TypeScript project enables
 * `allowImportingTsExtensions` or declares CSS modules. A leaf with no imports
 * is the only shape every world can read — and a shared predicate that cannot
 * be imported is a predicate that gets copied, which is exactly the second
 * answer to "does this touch Today" that #834 exists to prevent.
 *
 * `format.ts` and `logic.ts` re-export from here rather than restating any of
 * it, so there is one definition of the midnight problem's rules and one
 * definition of `landsToday`, wherever they are called from.
 */

/** A civil day key (`2026-08-21`) for an ISO instant or a date-only value. */
export function dayKey(value: string): string {
  return value.slice(0, 10);
}

/**
 * Is this due value DATE-ONLY? A bare `YYYY-MM-DD` carries no moment, which is
 * why it sorts before every timed task on its day and reminds at the member's
 * own morning rather than at midnight.
 */
export function isDateOnly(due: string | null | undefined): boolean {
  return typeof due === "string" && !due.includes("T");
}

/** Whole civil days from `from` to `to`, negative when `to` is earlier. */
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

/** The weekday a due value lands on — `next is Friday` and nothing else. */
export function weekdayName(value: string): string {
  const parsed = new Date(`${dayKey(value)}T00:00:00Z`);
  return WEEKDAYS[parsed.getUTCDay()] ?? "";
}

/** The month an old row has been sitting since — `sitting since March`. */
export function monthName(value: string): string {
  const index = Number(value.slice(5, 7)) - 1;
  return MONTHS[index] ?? "";
}

/** `17:00` from an ISO instant, in the vault's own wall clock. */
export function timeOfDay(value: string): string {
  return value.slice(11, 16);
}

/**
 * What a surface says about due-ness. A plain phrase, never a countdown and
 * never a colour word: overdue reads `2 days ago` and takes the attention tone
 * from the stylesheet, so the sentence is the same one a member would say.
 */
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

/** The two fields every "when" question reads off a task row. */
export interface TaskWhen {
  due_at?: string | null;
  /** The live occurrence of a repeating task, from the shared summariser. */
  next_due?: string | null;
}

/**
 * AN UNDATED TASK NEVER TOUCHES TODAY. Stated once, as a predicate, so no code
 * path can quietly answer it differently — the Today route, the Agenda shelf
 * and the home tile all ask this function.
 */
export function landsToday(task: TaskWhen, now: string): boolean {
  const due = task.next_due ?? task.due_at;
  if (!due) return false;
  return daysBetween(now, due) <= 0;
}

/** Is this row past its moment? The one question overdue tone is drawn from. */
export function isOverdueWhen(task: TaskWhen, now: string): boolean {
  const due = task.next_due ?? task.due_at;
  if (!due) return false;
  return daysBetween(now, due) < 0;
}
