import {
  metaParts,
  priorityLevel,
} from "@centraid/blueprints/apps/tasks/format";
import type { MetaPart } from "@centraid/blueprints/apps/tasks/format";
import type { Task } from "@centraid/blueprints/apps/tasks/types";
import { PRIORITY_CHIPS } from "@centraid/blueprints/apps/tasks/view-copy";

export interface TaskRowModel {
  meta: MetaPart[];
  priority: string | null;
}

export function taskRowModel(input: {
  task: Task;
  now: string;
  projectName?: string | null;
}): TaskRowModel {
  const level = priorityLevel(input.task.priority);
  return {
    meta: metaParts({
      task: input.task,
      now: input.now,
      ...(input.projectName ? { projectName: input.projectName } : {}),
    }),
    priority: level > 0 ? (PRIORITY_CHIPS[level] ?? null) : null,
  };
}
