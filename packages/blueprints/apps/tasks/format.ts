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
import {
  daysBetween,
  dueLabel,
  isOverdueWhen,
  monthName,
  weekdayName,
} from "./when.ts";

// THE WHEN RULES LIVE IN ONE PLACE — `when.ts`, an import-free leaf both the
// shell's Home tile and the phone can read (#834). They are re-exported here
// so every existing caller of `format.ts` is unchanged and there is still
// exactly one definition of each.
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

/** Is this row past its moment? The one question overdue tone is drawn from. */
export function isOverdue(task: Task, now: string): boolean {
  return isOverdueWhen(task, now);
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
