// How a task row says WHEN, and how its meta line is composed (spec §5).
//
// Pure, clock-injected and DOM-free on purpose. Every rule here is one a board
// gets wrong by expressing it inline in a render function: "2 days ago" versus
// "today, 17:00" is the date-only/timed distinction the midnight problem is
// made of (§9), and a helper that read `Date.now()` for itself could not be
// tested against either side of a boundary.
//
// NOTHING HERE DERIVES A RECURRENCE. `missed`, `next_due` and
// `recurrence_summary` arrive on the row from the ONE summariser behind
// `ctx.time` (queries/board.ts); this module only lays them out.
import type { Task } from "./types.ts";
import { familyProgress, missedLabel, sittingSince } from "./view-copy.ts";

/** A civil day key (`2026-08-21`) for an ISO instant or a date-only value. */
export function dayKey(value: string): string {
  return value.slice(0, 10);
}

/**
 * Is this due value DATE-ONLY? A bare `YYYY-MM-DD` carries no moment, which is
 * why it sorts before every timed task on its day and reminds at the member's
 * own morning rather than at midnight (§9's midnight problem).
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
 * What the meta line says about due-ness. A plain phrase, never a countdown and
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

/** Is this row past its moment? The one question overdue tone is drawn from. */
export function isOverdue(task: Task, now: string): boolean {
  const due = task.next_due ?? task.due_at;
  if (!due) return false;
  return daysBetween(now, due) < 0;
}

/** Every substring in the meta slot may be a number, and every number in this
 *  product is tabular and bidi-isolated — so a meta part declares whether it
 *  is one rather than leaving the row to guess. */
export interface MetaPart {
  text: string;
  numeric?: boolean;
  /** Overdue is the ONE part drawn in the attention tone. */
  attention?: boolean;
}

/**
 * The row's meta line, clamped to one line by the stylesheet and composed in
 * the spec's own order: project · due · repeats · missed · reminder · effort ·
 * tag · age · pending. A part that has nothing to say is absent, never blank.
 */
export function metaParts(input: {
  task: Task;
  now: string;
  projectName?: string | null;
  pending?: boolean;
}): MetaPart[] {
  const { task, now } = input;
  const parts: MetaPart[] = [];
  if (input.projectName) parts.push({ text: input.projectName });
  const due = dueLabel(task.next_due ?? task.due_at, now);
  if (due) {
    parts.push({
      text: due,
      numeric: true,
      ...(isOverdue(task, now) ? { attention: true } : {}),
    });
  }
  if (task.recurrence_summary) parts.push({ text: task.recurrence_summary });
  if ((task.missed ?? 0) > 0 && task.next_due) {
    parts.push({
      text: missedLabel(task.missed ?? 0, weekdayName(task.next_due)),
      numeric: true,
    });
  }
  if (typeof task.remind_before_min === "number") {
    parts.push({
      text: `reminder ${task.remind_before_min} min`,
      numeric: true,
    });
  }
  if (typeof task.effort_min === "number" && task.effort_min > 0) {
    parts.push({ text: `~${task.effort_min} min`, numeric: true });
  }
  const total = task.children?.length ?? 0;
  if (total > 0) {
    parts.push({
      text: familyProgress(task.done_children ?? 0, total),
      numeric: true,
    });
  }
  for (const tag of task.tags ?? []) parts.push({ text: `#${tag.label}` });
  const age = ageLabel(task, now);
  if (age) parts.push({ text: age });
  return parts;
}

/**
 * The age signal — drawn only once a row has genuinely been sitting, because a
 * fact about last week is not a fact worth a slot. Ninety days is the point at
 * which "when did I write this" stops being answerable from memory.
 */
export function ageLabel(task: Task, now: string): string | null {
  const born = task.created_at;
  if (!born || task.due_at) return null;
  return daysBetween(born, now) >= 90 ? sittingSince(monthName(born)) : null;
}

/** The four member-facing priority levels over RFC 5545's 1–9 (0 is unset). */
export function priorityLevel(priority: number | undefined): 0 | 1 | 2 | 3 {
  const value = Number(priority ?? 0);
  if (value <= 0) return 0;
  if (value <= 2) return 3;
  if (value <= 5) return 2;
  return 1;
}
