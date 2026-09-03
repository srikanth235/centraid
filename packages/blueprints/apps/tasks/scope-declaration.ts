import type { ScopeAppDeclaration } from "../_shared/scope-kit.ts";
import type { Task } from "./types.ts";

export const tasksScopeDeclaration: ScopeAppDeclaration<Task> = {
  mergeKey: (task) => task.task_id,
  mintedIdFamilies: ["schedule.task"],
  projectionIngest: "none",
};

export function taskDedupeIdentity(task: Task): string {
  return task.task_id;
}
