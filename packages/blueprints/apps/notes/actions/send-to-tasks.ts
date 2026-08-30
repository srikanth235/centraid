import {
  ACTION_PURPOSE,
  actionInput,
  deniedResult,
  runVaultAction,
} from "../../_shared/action-kit.ts";

/**
 * Send one checklist line to Tasks (#834).
 *
 * TWO COMMANDS, ONE SPINE. `schedule.add_task` mints the canonical task row —
 * the same one the board, the due shelf and the home tile read — and
 * `core.link_entities` adds the backlink. Notes stores nothing of its own: no
 * "sent" flag, no note-side copy, because a second store of task-ness is the
 * parallel mini-system this projection exists to prevent.
 *
 * The backlink is best-effort on purpose, so it swallows its own failure in
 * the kit's `settle` step: a task that landed is a real commitment, and
 * refusing the write over a missing decoration loses the member's intent.
 */
export default async function sendToTasks({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const title = String(input.title ?? "").trim();
  const noteId = String(input.note_id ?? "");
  if (!title) return deniedResult("A task needs a title.");
  return runVaultAction(
    ctx,
    {
      command: "schedule.add_task",
      input: {
        title,
        // Undated unless the line carried one; an undated task never reaches
        // Today or the calendar grid.
        ...(input.due_at ? { due_at: String(input.due_at) } : {}),
      },
    },
    async (outcome) => {
      const taskId = (outcome.output as { task_id?: string } | undefined)
        ?.task_id;
      if (outcome.status !== "executed" || !taskId || !noteId) return;
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
          purpose: ACTION_PURPOSE,
        })
        .catch(() => undefined);
    }
  );
}
