// Which rows each place shows. THE ARITHMETIC IS THE WEB APP'S: every group
// here comes back from `apps/tasks/logic.ts`; this module only says which of
// those answers a place is asking for.
//
// `null` means the place draws a surface of its own rather than a row list, so
// a new place cannot fall through to Today's rows by accident.

import { weekdayName } from "@centraid/blueprints/apps/tasks/format";
import {
  allGroups,
  anytimeGroups,
  inboxGroup,
  logbookGroups,
  todayGroups,
  upcomingGroups,
} from "@centraid/blueprints/apps/tasks/logic";
import type { Task, TaskGroup } from "@centraid/blueprints/apps/tasks/types";

import type { TasksPlaceKey } from "./tasks-places";

export interface TasksGroupsInput {
  place: TasksPlaceKey;
  tasks: readonly Task[];
  now: string;
  projectName: (id: string | null | undefined) => string;
}

export function groupsFor(input: TasksGroupsInput): TaskGroup[] | null {
  const { place, tasks, now } = input;
  if (place === "today") return todayGroups(tasks, now);
  if (place === "upcoming") return upcomingGroups(tasks, now, weekdayName);
  if (place === "inbox") {
    const group = inboxGroup(tasks);
    return group.rows.length > 0 ? [group] : [];
  }
  if (place === "anytime") return anytimeGroups(tasks, input.projectName);
  if (place === "all") return allGroups(tasks);
  if (place === "logbook") return logbookGroups(tasks);
  return null;
}

/** A row by id, families included. The board holds roots with their children
 *  nested, so a subtask is only reachable through its parent. */
export function findTask(
  rows: readonly Task[],
  taskId: string | null
): Task | undefined {
  if (!taskId) return undefined;
  for (const row of rows) {
    if (row.task_id === taskId) return row;
    const child = (row.children ?? []).find(
      (entry) => entry.task_id === taskId
    );
    if (child) return child;
  }
  return undefined;
}

/** One flat item the list draws: a group header, or a task under it — the
 *  child rides the same list so virtualization reaches it. */
export type TasksListItem =
  | { kind: "header"; key: string; group: TaskGroup }
  | { kind: "task"; key: string; task: Task; child?: boolean };

export function flattenGroups(groups: readonly TaskGroup[]): TasksListItem[] {
  return groups.flatMap((group) => [
    { kind: "header" as const, key: `h:${group.key}`, group },
    ...group.rows.flatMap((task) => [
      { kind: "task" as const, key: task.task_id, task },
      ...(task.children ?? []).map((child) => ({
        kind: "task" as const,
        key: child.task_id,
        task: child,
        child: true,
      })),
    ]),
  ]);
}
