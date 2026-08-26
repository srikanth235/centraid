// The Tasks write door (#864): every act names its HOUSE scope when it has
// one, and Delete is a delete — never a cancelled status wearing the verb.

export function taskWrite(args: {
  action: string;
  input: Record<string, unknown>;
  scopeId?: string | null;
}): {
  action: string;
  input: Record<string, unknown>;
  scope?: string;
} {
  return {
    action: args.action,
    input: args.input,
    ...(args.scopeId ? { scope: args.scopeId } : {}),
  };
}

/** A write names a HOUSE scope only when that id is actually mounted.
 *  An unrecognised `scope_id` (a vault-row leftover, a pending stamp)
 *  must not ride through to `bindingFor`, which throws UNKNOWN_SCOPE
 *  and leaves the row unchanged. */
export function mountedWriteScope(
  scopeId: string | null | undefined,
  mountedIds: readonly string[]
): string | null {
  if (!scopeId) return null;
  return mountedIds.includes(scopeId) ? scopeId : null;
}

/** Optimistic add projects `pending:<intent>:task`. Completing that
 *  synthetic id is a vault miss; wait for the landed row instead. */
export function isPendingTaskId(taskId: string): boolean {
  return taskId.startsWith("pending:");
}

export function landedTask<T extends { task_id: string; title: string }>(
  task: Pick<T, "task_id" | "title">,
  rows: readonly T[]
): T | undefined {
  if (!isPendingTaskId(task.task_id)) {
    return rows.find((row) => row.task_id === task.task_id);
  }
  return rows.find(
    (row) => row.title === task.title && !isPendingTaskId(row.task_id)
  );
}

/** The delete-confirm's own write: remove the row, do not cancel it. */
export function removeTaskWrite(taskId: string): {
  action: "delete";
  input: { task_id: string };
} {
  return { action: "delete", input: { task_id: taskId } };
}
