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

export function mountedWriteScope(
  scopeId: string | null | undefined,
  mountedIds: readonly string[]
): string | null {
  if (!scopeId) return null;
  return mountedIds.includes(scopeId) ? scopeId : null;
}

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

export function landedTaskId(outcome: unknown): string | null {
  const output = (outcome as { output?: { task_id?: unknown } } | null)?.output;
  return typeof output?.task_id === "string" ? output.task_id : null;
}

export function removeTaskWrite(taskId: string): {
  action: "delete";
  input: { task_id: string };
} {
  return { action: "delete", input: { task_id: taskId } };
}
