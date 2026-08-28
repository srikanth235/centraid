// What one row SAYS, as values (Tasks spec §5) — pure, so the tone and the
// priority are testable without a renderer.

import {
  metaParts,
  priorityLevel,
} from "@centraid/blueprints/apps/tasks/format";
import type { MetaPart } from "@centraid/blueprints/apps/tasks/format";
import type { Task } from "@centraid/blueprints/apps/tasks/types";
import { PRIORITY_CHIPS } from "@centraid/blueprints/apps/tasks/view-copy";

export interface TaskRowModel {
  /** Each part keeps the tone `metaParts` gave it: flattening these to one
   *  string is what dropped overdue's. */
  meta: MetaPart[];
  /** `null` at level 0 — the row reserves no room for a priority nobody set. */
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
