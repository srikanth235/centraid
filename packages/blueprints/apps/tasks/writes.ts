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

/**
 * The row this task IS, in the current board.
 *
 * There is no "landed" id to wait for any more (#922 G2): the projection mints
 * the task's real id, the write carries it and the origin honours it, so the
 * id an optimistic row shows is the id the vault will hold. Matching by title
 * — the old fallback for a `pending:` id that never became canonical — is
 * gone with the grammar that made it necessary.
 */
export function boardTask<T extends { task_id: string }>(
  task: Pick<T, "task_id">,
  rows: readonly T[]
): T | undefined {
  return rows.find((row) => row.task_id === task.task_id);
}

/** The id `add` minted, or `null` while the write is still queued. */
export function landedTaskId(outcome: unknown): string | null {
  const output = (outcome as { output?: { task_id?: unknown } } | null)?.output;
  return typeof output?.task_id === "string" ? output.task_id : null;
}

/** The delete-confirm's own write: remove the row, do not cancel it. */
export function removeTaskWrite(taskId: string): {
  action: "delete";
  input: { task_id: string };
} {
  return { action: "delete", input: { task_id: taskId } };
}
