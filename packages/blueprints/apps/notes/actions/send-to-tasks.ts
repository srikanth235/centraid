/**
 * Send one checklist line to Tasks (#834).
 *
 * TWO COMMANDS, ONE SPINE. `schedule.add_task` mints the canonical task row —
 * the SAME row Tasks' board, Agenda's due shelf and the home tile read — and
 * `core.link_entities` puts an edge back to the note so the task can say where
 * it came from. Notes writes nothing of its own: there is no "sent" flag on
 * the line and no note-side copy of the task, because a second store of
 * task-ness is exactly the parallel mini-system this projection exists to
 * prevent.
 *
 * The link is best-effort ON PURPOSE. If the task landed and only the edge
 * failed, the commitment still exists and is visible in the room that owns it;
 * refusing the whole write over a missing backlink would lose the member's
 * intent to keep a decoration. The outcome says which happened.
 */
export default async function sendToTasks({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  const title = String(input.title ?? "").trim();
  const noteId = String(input.note_id ?? "");
  if (!title) {
    return {
      status: 200,
      body: { status: "denied", reason: "A task needs a title." },
    };
  }
  try {
    const outcome = (await ctx.vault.invoke({
      command: "schedule.add_task",
      input: {
        title,
        // Undated unless the line carried a date. An undated task never
        // touches Today and never reaches the calendar grid.
        ...(input.due_at ? { due_at: String(input.due_at) } : {}),
      },
      purpose: "dpv:ServiceProvision",
    })) as { status?: string; output?: { task_id?: string } };

    const taskId = outcome?.output?.task_id;
    if (outcome?.status === "executed" && taskId && noteId) {
      const exact = String(input.exact ?? "");
      await ctx.vault
        .invoke({
          command: "core.link_entities",
          input: {
            from_type: "schedule.task",
            from_id: taskId,
            to_type: "knowledge.note",
            to_id: noteId,
            relation: "references",
            ...(exact ? { selector: { exact, prefix: "", suffix: "" } } : {}),
          },
          purpose: "dpv:ServiceProvision",
        })
        .catch(() => undefined);
    }
    return { status: 200, body: outcome };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      status: 200,
      body: { status: "denied", reason: e.message, code: e.code },
    };
  }
}
