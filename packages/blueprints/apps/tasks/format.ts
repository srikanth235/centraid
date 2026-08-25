// Task-row WHEN formatting and meta-line composition (spec §5). Pure,
// clock-injected, DOM-free. NOTHING HERE DERIVES A RECURRENCE — this module
// only lays out what the summariser produced.
import type { Task } from "./types.ts";
import { familyProgress, missedLabel, sittingSince } from "./view-copy.ts";
import {
  daysBetween,
  dueLabel,
  isOverdueWhen,
  monthName,
  weekdayName,
} from "./when.ts";

// WHEN rules live once in when.ts (#834).
export {
  dayKey,
  daysBetween,
  dueLabel,
  isDateOnly,
  isOverdueWhen,
  monthName,
  timeOfDay,
  weekdayName,
} from "./when.ts";

export function isOverdue(task: Task, now: string): boolean {
  return isOverdueWhen(task, now);
}

/** A meta part; numbers are tabular and bidi-isolated. */
export interface MetaPart {
  text: string;
  numeric?: boolean;
  /** Overdue is the ONE part drawn in the attention tone. */
  attention?: boolean;
}

/** Meta line, spec order: project · due · repeats · missed · reminder · effort · tag. */
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

/** Age signal: only once an undated row has sat 90+ days. */
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
