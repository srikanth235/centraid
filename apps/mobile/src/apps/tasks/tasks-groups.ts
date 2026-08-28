// Which rows each place shows. THE ARITHMETIC IS THE WEB APP'S: every group
// comes back from `apps/tasks/logic.ts`. `null` means the place draws a
// surface of its own, so a new one cannot fall through to Today's rows.

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

export type TasksListItem =
  | { kind: "header"; key: string; group: TaskGroup }
  | { kind: "task"; key: string; task: Task; child?: boolean };

/** A header whose rows all fell past the edge is dropped — a group name over
 *  nothing is a claim the list is not making. */
export function windowItems(
  items: readonly TasksListItem[],
  window: number
): { items: TasksListItem[]; shown: number; total: number } {
  const total = items.filter((item) => item.kind === "task").length;
  if (total <= window) return { items: [...items], shown: total, total };
  const kept: TasksListItem[] = [];
  let shown = 0;
  for (const item of items) {
    if (item.kind === "task") {
      if (shown >= window) break;
      shown += 1;
    }
    kept.push(item);
  }
  while (kept.length > 0 && kept[kept.length - 1]?.kind === "header") {
    kept.pop();
  }
  return { items: kept, shown, total };
}

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
