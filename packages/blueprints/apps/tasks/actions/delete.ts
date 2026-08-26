/**
 * Remove a task and its subtasks through the vault's typed command. Delete
 * is removal, not a cancelled status — the confirm already promised the
 * Logbook keeps nothing.
 */
export default async function deleteTask({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "schedule.delete_task",
      input: { task_id: String(input.task_id ?? "") },
      purpose: "dpv:ServiceProvision",
    });
    return { status: 200, body: outcome };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      status: 200,
      body: { status: "denied", reason: e.message, code: e.code },
    };
  }
}
