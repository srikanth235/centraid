// What each route SHOWS, derived from one board read (spec §1, §4). Pure,
// DOM-free; boardState is the one answer to "what is this screen saying".
import { showsEmptyState } from "../_shared/view-state-kit.ts";
import { daysBetween, isOverdue } from "./format.ts";
import type { BoardData, ReentryBucket, Task, TaskGroup } from "./types.ts";
import { DONE, GROUPS, WONT_DO, inboxMeta, overdueMeta } from "./view-copy.ts";
import { isOpenStatus, landsToday } from "./when.ts";

// `landsToday` and family nesting live in `when.ts` (#834) and are
// re-exported so every caller of `logic.ts` still has one definition.
export { landsToday, nestTaskFamilies } from "./when.ts";

export function isOpen(task: Task): boolean {
  return isOpenStatus(task.status);
}

/** One Catch-up bulk verb → the writes it actually fires. Sitting is Release
 *  all: cancel, never stamp Today onto an undated someday row. */
export function catchUpWrites(
  key: ReentryBucket["key"],
  rows: readonly Pick<Task, "task_id">[],
  today: string
): Array<{ action: string; input: Record<string, unknown> }> {
  if (key === "sitting") {
    return rows.map((row) => ({
      action: "set-status",
      input: { task_id: row.task_id, status: "cancelled" },
    }));
  }
  if (key === "repeating") {
    return rows.map((row) => ({
      action: "set-status",
      input: { task_id: row.task_id, status: "completed" },
    }));
  }
  return rows.map((row) => ({
    action: "edit",
    input: { task_id: row.task_id, due_at: today },
  }));
}

/** Date-only first, then moment — a date-only task has no moment and must not
 *  string-sort after a 17:00 meeting. Undated sorts LAST (ruling 4). Same-day
 *  rows stay TIED here, for callers that break the tie their own way. */
export function byDueDay(a: Task, b: Task): number {
  const left = a.next_due ?? a.due_at ?? "";
  const right = b.next_due ?? b.due_at ?? "";
  if (left === right) return 0;
  if (left === "" || right === "") return left === "" ? 1 : -1;
  return left < right ? -1 : 1;
}

export function byDue(a: Task, b: Task): number {
  return byDueDay(a, b) || a.title.localeCompare(b.title);
}

/** Today: overdue first with its own header and its own verbs, then today. */
export function todayGroups(rows: readonly Task[], now: string): TaskGroup[] {
  const open = rows.filter(isOpen);
  const overdue = open.filter((task) => isOverdue(task, now)).sort(byDue);
  const today = open
    .filter((task) => landsToday(task, now) && !isOverdue(task, now))
    .sort(byDue);
  const groups: TaskGroup[] = [];
  if (overdue.length > 0) {
    groups.push({
      key: "overdue",
      label: GROUPS.overdue,
      meta: overdueMeta(overdue.length),
      attention: true,
      rows: overdue,
    });
  }
  if (today.length > 0) {
    groups.push({ key: "today", label: GROUPS.today, rows: today });
  }
  return groups;
}

/** Upcoming: one group per civil day, nearest first; Today keeps its own rows. */
export function upcomingGroups(
  rows: readonly Task[],
  now: string,
  dayLabel: (day: string) => string
): TaskGroup[] {
  const byDay = new Map<string, Task[]>();
  for (const task of rows) {
    if (!isOpen(task)) continue;
    const due = task.next_due ?? task.due_at;
    if (!due || daysBetween(now, due) <= 0) continue;
    const key = due.slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)?.push(task);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, group]) => ({
      key: day,
      label: dayLabel(day),
      rows: [...group].sort(byDue),
    }));
}

/** Anytime: the undated, grouped by where they belong. */
export function anytimeGroups(
  rows: readonly Task[],
  projectName: (id: string | null | undefined) => string
): TaskGroup[] {
  const byProject = new Map<string, Task[]>();
  for (const task of rows) {
    if (!isOpen(task) || task.due_at || task.next_due) continue;
    const key = task.project_id ?? "";
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)?.push(task);
  }
  return [...byProject.entries()]
    .sort(([a], [b]) => projectName(a).localeCompare(projectName(b)))
    .map(([id, group]) => ({
      key: id || "inbox",
      label: id ? projectName(id) : GROUPS.inbox,
      rows: [...group].sort(byDue),
    }));
}

/** All: dated and undated, two groups and no third (the spec's split). */
export function allGroups(rows: readonly Task[]): TaskGroup[] {
  const open = rows.filter(isOpen);
  const dated = open.filter((task) => task.due_at ?? task.next_due);
  const undated = open.filter((task) => !(task.due_at ?? task.next_due));
  const groups: TaskGroup[] = [];
  if (dated.length > 0) {
    groups.push({
      key: "dated",
      label: GROUPS.dated,
      rows: [...dated].sort(byDue),
    });
  }
  if (undated.length > 0) {
    groups.push({
      key: "undated",
      label: GROUPS.undated,
      rows: [...undated].sort(byDue),
    });
  }
  return groups;
}

export function byClosed(a: Task, b: Task): number {
  const left = a.completed_at ?? "";
  const right = b.completed_at ?? "";
  if (left === right) return a.title.localeCompare(b.title);
  if (left === "" || right === "") return left === "" ? 1 : -1;
  return left < right ? 1 : -1;
}

/** The Logbook: two OUTCOMES, never one undifferentiated pile. */
export function logbookGroups(rows: readonly Task[]): TaskGroup[] {
  const closed = rows.filter((task) => !isOpen(task));
  const groups: TaskGroup[] = [];
  const done = closed
    .filter((task) => task.status === "completed")
    .sort(byClosed);
  const released = closed
    .filter((task) => task.status === "cancelled")
    .sort(byClosed);
  if (done.length > 0) groups.push({ key: "done", label: DONE, rows: done });
  if (released.length > 0)
    groups.push({ key: "wont-do", label: WONT_DO, rows: released });
  return groups;
}

/** A lead time on an undated row reminds about nothing. */
export function remindingTasks(rows: readonly Task[]): Task[] {
  return rows
    .filter(
      (task) =>
        isOpen(task) &&
        typeof task.remind_before_min === "number" &&
        Boolean(task.next_due ?? task.due_at)
    )
    .sort(byDue);
}

/** The Inbox: unfiled rows, an age signal on each, and no badge anywhere. */
export function inboxGroup(rows: readonly Task[]): TaskGroup {
  const unfiled = rows
    .filter((task) => isOpen(task) && !task.project_id)
    .sort(byDue);
  return {
    key: "inbox",
    label: GROUPS.inbox,
    meta: inboxMeta(unfiled.length),
    rows: unfiled,
  };
}

/** Away-days measured from the oldest thing that came due; zero = not away. */
export function awayDays(rows: readonly Task[], now: string): number {
  const overdue = rows.filter((task) => isOpen(task) && isOverdue(task, now));
  if (overdue.length === 0) return 0;
  const oldest = overdue
    .map((task) => task.next_due ?? task.due_at ?? "")
    .filter(Boolean)
    .sort()[0];
  return oldest ? Math.max(0, daysBetween(oldest, now)) : 0;
}

/** The absence to name, or null; a week is the threshold (a two-day pile is a
 *  Tuesday). */
export function absence(
  rows: readonly Task[],
  now: string
): { days: number; due: number } | null {
  const days = awayDays(rows, now);
  if (days < 7) return null;
  const due = rows.filter(
    (task) => isOpen(task) && isOverdue(task, now)
  ).length;
  return due > 0 ? { days, due } : null;
}

/** Catch up's three piles (§3); a row belongs to exactly one, so no bulk verb
 *  acts on the same task twice. */
export function reentryBuckets(
  rows: readonly Task[],
  now: string,
  labels: Record<ReentryBucket["key"], { label: string; verb: string }>
): ReentryBucket[] {
  const open = rows.filter(isOpen);
  const repeating = open.filter((task) => Boolean(task.rrule));
  const repeatingIds = new Set(repeating.map((task) => task.task_id));
  const dated = open.filter(
    (task) => !repeatingIds.has(task.task_id) && isOverdue(task, now)
  );
  const datedIds = new Set(dated.map((task) => task.task_id));
  const sitting = open.filter(
    (task) =>
      !repeatingIds.has(task.task_id) &&
      !datedIds.has(task.task_id) &&
      !(task.due_at ?? task.next_due) &&
      Boolean(task.created_at) &&
      daysBetween(task.created_at ?? now, now) >= 90
  );
  const bucket = (key: ReentryBucket["key"], group: Task[]): ReentryBucket => ({
    key,
    label: labels[key].label,
    verb: labels[key].verb,
    rows: [...group].sort(byDue),
  });
  return [
    bucket("dated", dated),
    bucket("repeating", repeating),
    bucket("sitting", sitting),
  ].filter((entry) => entry.rows.length > 0);
}

/** The one answer to "what is this screen saying right now" (§4), ordered by
 *  what OVERRIDES what: denial > loading > empties > live. */
export type BoardStateName =
  | "loading"
  | "denied"
  | "day-one"
  | "all-done"
  | "nothing-scheduled"
  | "live";

export function boardState(input: {
  loaded: boolean;
  denied: boolean;
  rows: readonly Task[];
  logbook: readonly Task[];
  projects: readonly unknown[];
  now: string;
}): BoardStateName {
  if (input.denied) return "denied";
  if (!input.loaded) return "loading";
  const open = input.rows.filter(isOpen);
  if (
    showsEmptyState({ loaded: input.loaded, count: open.length }) &&
    input.logbook.length === 0 &&
    input.projects.length === 0
  ) {
    return "day-one";
  }
  const dueToday = open.filter((task) => landsToday(task, input.now));
  if (dueToday.length > 0) return "live";
  // The two quiets are different facts: did anything come due today at all?
  const closedToday = input.logbook.filter(
    (task) =>
      task.completed_at && daysBetween(task.completed_at, input.now) === 0
  );
  return closedToday.length > 0 ? "all-done" : "nothing-scheduled";
}

/** Is the board showing a window? The query answered; this pairs it with the
 *  two numbers the notice says. */
export function windowEnd(
  data: Pick<BoardData, "counts" | "open">,
  truncated: boolean
): { shown: number; total: number } | null {
  if (!truncated) return null;
  return {
    shown: data.open.length,
    total: data.counts.open ?? data.open.length,
  };
}
