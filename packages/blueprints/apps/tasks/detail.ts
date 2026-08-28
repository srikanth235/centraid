// What the task detail place SAYS and WRITES (spec §5). Pure and DOM-free, so
// the pointer editor and the phone's detail surface project one answer instead
// of two that drift.
//
// THE FIELD LIST IS A PROJECTION, NOT A LAYOUT: a field is absent when the row
// has no answer for it, so nothing draws a repeat control on a task that does
// not repeat, or an anchor on one whose missed periods mean nothing.
import { dueLabel, isDateOnly, priorityLevel, timeOfDay } from "./format.ts";
import type { Project, Task, TaskStatus } from "./types.ts";
import {
  ANCHOR_CARDS,
  ANCHOR_NOTE,
  DATE_ONLY_REMINDER,
  EFFORT_CHIPS,
  EFFORT_NOTE_A,
  EFFORT_NOTE_B,
  FIELDS,
  FIELD_EMPTY,
  GROUPS,
  HOME_VAULT_NOTE_A,
  HOME_VAULT_NOTE_B,
  LIFECYCLE,
  MISSED_NOTE_A,
  MISSED_NOTE_B,
  PRIORITY_CHIPS,
  PRIORITY_NOTE_A,
  PRIORITY_NOTE_B,
  PROMOTION_A,
  PROMOTION_B,
  REMINDER_NOTE_A,
  REMINDER_NOTE_B,
  SUBTASK_CAP,
  TAGS_NOTE_A,
  TAGS_NOTE_B,
  homeVault,
  missedLabel,
  reminderLead,
} from "./view-copy.ts";
import { weekdayName } from "./when.ts";

/** At five children the place states what the task has become and offers the
 *  promotion. The cap is a discipline, not an apology (§3). */
export const PROMOTION_AT = 5;

/** Minutes behind `EFFORT_CHIPS`, index for index; 0 is unset. */
export const EFFORT_MINUTES: readonly number[] = [0, 5, 15, 25, 60];

export interface EffortChoice {
  label: string;
  minutes: number;
}

/** The effort choices that actually WRITE. `edit_task` takes `effort_min >= 1`
 *  (app.json), so `EFFORT_CHIPS[0]` would dispatch a no-op — it is the field's
 *  value when nothing is set, never a control. */
export const EFFORT_CHOICES: readonly EffortChoice[] = EFFORT_CHIPS.slice(
  1
).map((label, index) => ({ label, minutes: EFFORT_MINUTES[index + 1] ?? 0 }));

export type TaskFieldKey =
  | "when"
  | "time"
  | "reminder"
  | "repeats"
  | "anchor"
  | "missed"
  | "priority"
  | "effort"
  | "project"
  | "tags"
  | "homeVault"
  | "attached";

export interface TaskField {
  key: TaskFieldKey;
  label: string;
  /** What the field states. `null` where the row's own control IS the answer
   *  (the tag chips, the attachment list) and a summary would repeat it. */
  value: string | null;
  notes: readonly string[];
}

export interface TaskFieldsInput {
  task: Task;
  now: string;
  projectName?: string | null;
  /** The vault this task was born in, and who else can see it where the seat
   *  knows. A personal task passes nothing — personal is silence. */
  home?: { vault: string; who?: string } | null;
}

export function repeats(task: Task): boolean {
  return Boolean(task.rrule);
}

export function anchorOf(task: Task): "scheduled" | "completion" {
  return task.recurrence_anchor ?? "scheduled";
}

/** The chosen card's own head — the anchor is stated in the words the member
 *  chose it by, never as the stored token. */
export function anchorHead(task: Task): string {
  const chosen = anchorOf(task);
  return ANCHOR_CARDS.find((card) => card.value === chosen)?.head ?? chosen;
}

export function effortIndex(task: Task): number {
  const minutes = task.effort_min ?? 0;
  const index = EFFORT_MINUTES.indexOf(minutes);
  return index < 0 ? 0 : index;
}

export function familySize(task: Task): number {
  return task.children?.length ?? 0;
}

/** One level only — until the family outgrows the cap, when the note stops
 *  restating the rule and states what the task has become. */
export function subtaskNotes(task: Task): readonly string[] {
  return familySize(task) >= PROMOTION_AT
    ? [PROMOTION_A, PROMOTION_B]
    : [SUBTASK_CAP];
}

export function taskFields(input: TaskFieldsInput): TaskField[] {
  const { task, now } = input;
  const due = task.next_due ?? task.due_at;
  const fields: TaskField[] = [
    {
      key: "when",
      label: FIELDS.when,
      value: dueLabel(due, now) ?? FIELD_EMPTY,
      notes: [],
    },
  ];
  // Time is the date-only/at-a-time distinction, and only a dated row has one.
  if (due) {
    fields.push({
      key: "time",
      label: FIELDS.time,
      value: isDateOnly(due) ? null : timeOfDay(due),
      notes: isDateOnly(due) ? [DATE_ONLY_REMINDER] : [],
    });
  }
  fields.push({
    key: "reminder",
    label: FIELDS.reminder,
    value:
      typeof task.remind_before_min === "number"
        ? reminderLead(task.remind_before_min)
        : FIELD_EMPTY,
    notes: [REMINDER_NOTE_A, REMINDER_NOTE_B],
  });
  if (task.recurrence_summary) {
    fields.push({
      key: "repeats",
      label: FIELDS.repeats,
      value: task.recurrence_summary,
      notes: [MISSED_NOTE_A, MISSED_NOTE_B],
    });
  }
  if (repeats(task)) {
    fields.push({
      key: "anchor",
      label: FIELDS.anchor,
      value: anchorHead(task),
      notes: [ANCHOR_NOTE],
    });
  }
  const missed = task.missed ?? 0;
  if (missed > 0 && task.next_due) {
    fields.push({
      key: "missed",
      label: FIELDS.missed,
      value: missedLabel(missed, weekdayName(task.next_due)),
      notes: [],
    });
  }
  fields.push(
    {
      key: "priority",
      label: FIELDS.priority,
      value: PRIORITY_CHIPS[priorityLevel(task.priority)] ?? PRIORITY_CHIPS[0],
      notes: [PRIORITY_NOTE_A, PRIORITY_NOTE_B],
    },
    {
      key: "effort",
      label: FIELDS.effort,
      value: EFFORT_CHIPS[effortIndex(task)] ?? EFFORT_CHIPS[0],
      notes: [EFFORT_NOTE_A, EFFORT_NOTE_B],
    },
    {
      key: "project",
      label: FIELDS.project,
      value: input.projectName ?? GROUPS.inbox,
      notes: [],
    },
    {
      key: "tags",
      label: FIELDS.tags,
      value: null,
      notes: [TAGS_NOTE_A, TAGS_NOTE_B],
    }
  );
  if (input.home) {
    fields.push({
      key: "homeVault",
      label: FIELDS.homeVault,
      value: input.home.who
        ? homeVault(input.home.vault, input.home.who)
        : input.home.vault,
      notes: [HOME_VAULT_NOTE_A, HOME_VAULT_NOTE_B],
    });
  }
  if ((task.attachments ?? []).length > 0) {
    fields.push({
      key: "attached",
      label: FIELDS.attached,
      value: null,
      notes: [],
    });
  }
  return fields;
}

/** Start/Stop, or nothing at all: a completed or released row has no run to
 *  begin or halt, and offering one would name a state it cannot reach. */
export function lifecycleAct(
  task: Task
): { verb: string; status: TaskStatus } | null {
  if (task.status === "needs-action")
    return { verb: LIFECYCLE.start, status: "in-process" };
  if (task.status === "in-process")
    return { verb: LIFECYCLE.stop, status: "needs-action" };
  return null;
}

/**
 * `organize-task` is the ONE door for the anchor, and it requires the row's
 * `sort_order` — preserved, never reset, or the member's manual order collapses
 * every time they change an anchor.
 */
export function anchorWrite(
  task: Task,
  anchor: "scheduled" | "completion",
  timeZone: string
): Record<string, string | number> {
  return {
    task_id: task.task_id,
    sort_order: task.sort_order ?? 0,
    recurrence_anchor: anchor,
    recurrence_tz: task.recurrence_tz ?? timeZone,
  };
}

/** Filing travels the same door for the same reason. */
export function projectWrite(
  task: Task,
  projectId: string | null
): Record<string, string | number | boolean> {
  return {
    task_id: task.task_id,
    sort_order: task.sort_order ?? 0,
    ...(projectId ? { project_id: projectId } : { clear_project: true }),
  };
}

export function projectNameOf(
  task: Task,
  projects: readonly Project[]
): string | null {
  return (
    projects.find((project) => project.project_id === task.project_id)?.name ??
    null
  );
}
