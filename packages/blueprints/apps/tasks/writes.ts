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

/** The delete-confirm's own write: remove the row, do not cancel it. */
export function removeTaskWrite(taskId: string): {
  action: "delete";
  input: { task_id: string };
} {
  return { action: "delete", input: { task_id: taskId } };
}
